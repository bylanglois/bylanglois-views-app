// --- 1. SETUP ---
import express from 'express';
import cors from 'cors';
import { shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

const app = express();
app.use(express.json());
app.use(cors());

// --- Shopify API Client Setup ---
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY,
  scopes: ['write_metaobjects', 'read_metaobjects'],
  hostName: 'galerie-langlois.myshopify.com',
  isEmbeddedApp: false,
});

const session = {
  shop: 'galerie-langlois.myshopify.com',
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
};

const client = new shopify.clients.Graphql({ session });

// --- 2. TEMP STORAGE FOR PENDING VIEWS ---
const pendingUpdates = new Map();

// --- 3. INCREMENT ENDPOINT (FAST, NO SHOPIFY) ---
app.post('/api/increment-view', (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) {
      return res.status(400).json({ error: 'Post ID is required' });
    }

    const current = pendingUpdates.get(postId) || 0;
    pendingUpdates.set(postId, current + 1);

    console.log(`Stored view for ${postId}, now pending: ${pendingUpdates.get(postId)}`);

    res.status(202).json({ success: true, message: 'View stored for batch' });
  } catch (error) {
    console.error('Error incrementing view:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- 4. PROCESS BATCH (RUNS BY CRON JOB) ---
app.post('/api/process-batch', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (pendingUpdates.size === 0) {
    console.log('No pending updates to process.');
    return res.status(200).json({ success: true, message: 'Nothing to update' });
  }

  console.log(`Processing batch of ${pendingUpdates.size} posts...`);

  const updatesToProcess = new Map(pendingUpdates);
  pendingUpdates.clear();

  try {
    // Step 1: Fetch all metaobjects once
    const findMetaobjectQuery = `
      query {
        metaobjects(type: "custom_post_views", first: 100) {
          edges {
            node {
              id
              fields { key value }
            }
          }
        }
      }
    `;
    const findResponse = await client.query({ data: { query: findMetaobjectQuery } });
    const allMetaobjects = findResponse.body.data.metaobjects.edges.map(e => e.node);

    // Step 2: Prepare payload
    const updatesPayload = [];
    for (const [postId, viewsToAdd] of updatesToProcess.entries()) {
      const metaobject = allMetaobjects.find(node =>
        node.fields.some(f => f.key === "post_id" && f.value === postId)
      );
      if (metaobject) {
        const viewField = metaobject.fields.find(f => f.key === "view_count");
        const currentViews = parseInt(viewField?.value || "0", 10);
        const newTotal = currentViews + viewsToAdd;

        updatesPayload.push({
          id: metaobject.id,
          viewCount: newTotal.toString(),
        });
      }
    }

    if (updatesPayload.length === 0) {
      return res.status(200).json({ success: true, message: 'No matching metaobjects found' });
    }

    // Step 3: Build GraphQL mutation
    const mutationParts = updatesPayload.map((u, i) => `
      update_${i}: metaobjectUpdate(
        id: "${u.id}",
        metaobject: { fields: [{ key: "view_count", value: "${u.viewCount}" }] }
      ) {
        metaobject { id }
        userErrors { field message }
      }
    `).join('\n');

    const combinedMutation = `mutation { ${mutationParts} }`;
    await client.query({ data: { query: combinedMutation } });

    console.log(`Updated ${updatesPayload.length} metaobjects in Shopify`);
    res.status(200).json({ success: true, updated: updatesPayload.length });

  } catch (error) {
    console.error('Error processing batch update:', error);
    res.status(500).json({ error: 'Batch update failed' });
  }
});

// --- 5. GET VIEWS ENDPOINT ---
app.get('/api/get-views/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    if (!postId) return res.status(400).json({ error: 'Post ID required' });

    const findMetaobjectQuery = `
      query {
        metaobjects(type: "custom_post_views", first: 100) {
          edges {
            node {
              id
              fields { key value }
            }
          }
        }
      }
    `;
    const findResponse = await client.query({ data: { query: findMetaobjectQuery } });
    const allMetaobjects = findResponse.body.data.metaobjects.edges.map(e => e.node);

    const metaobject = allMetaobjects.find(node =>
      node.fields.some(f => f.key === "post_id" && f.value === postId)
    );

    if (!metaobject) {
      return res.status(200).json({ success: true, currentViewCount: 0 });
    }

    const viewField = metaobject.fields.find(f => f.key === "view_count");
    const currentViews = parseInt(viewField?.value || "0", 10);

    res.status(200).json({ success: true, currentViewCount: currentViews });
  } catch (error) {
    console.error('Error fetching views:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- 6. HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('ByLanglois Views API (Batch Version) is running.');
});

export default app;
