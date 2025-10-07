// --- 1. SETUP ---
import express from 'express';
import cors from 'cors';
import { shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

const app = express();
app.use(express.json());
app.use(cors());

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

// --- 2. MEMORY CACHE (Batch buffer) ---
const pendingUpdates = new Map();

// --- 3. INCREMENT ENDPOINT ---
app.post('/api/increment-view', async (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ error: 'Post ID is required' });

    // On stocke juste en mémoire, pas dans Shopify
    const current = pendingUpdates.get(postId) || 0;
    pendingUpdates.set(postId, current + 1);

    console.log(`Pending +1 for postId=${postId}, total=${pendingUpdates.get(postId)}`);

    // Réponse immédiate
    res.status(202).json({ success: true, message: 'View queued for batch update' });
  } catch (error) {
    console.error('Error incrementing view (cache):', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- 4. PROCESS BATCH (cron) ---
app.post('/api/process-batch', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (pendingUpdates.size === 0) {
    console.log('No pending updates.');
    return res.status(200).json({ success: true, message: 'Nothing to process' });
  }

  const updatesToProcess = new Map(pendingUpdates);
  pendingUpdates.clear();

  try {
    // 1. Fetch tous les metaobjects
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

    // 2. Construire mutation
    const mutationParts = [];
    let alias = 0;

    for (const [postId, increment] of updatesToProcess.entries()) {
      const metaobject = allMetaobjects.find(node =>
        node.fields.some(f => f.key === "post_id" && f.value === postId)
      );

      if (!metaobject) continue;

      const viewField = metaobject.fields.find(f => f.key === "view_count");
      const currentCount = parseInt(viewField?.value || "0", 10);
      const newTotal = currentCount + increment;

      mutationParts.push(`
        update_${alias++}: metaobjectUpdate(
          id: "${metaobject.id}",
          metaobject: { fields: [{ key: "view_count", value: "${newTotal}" }] }
        ) {
          metaobject { id }
          userErrors { field message }
        }
      `);
    }

    if (mutationParts.length === 0) {
      return res.status(200).json({ success: true, message: 'No matching metaobjects' });
    }

    const combinedMutation = `mutation { ${mutationParts.join('\n')} }`;
    await client.query({ data: { query: combinedMutation } });

    console.log(`Batch updated ${mutationParts.length} posts`);
    res.status(200).json({ success: true, updated: mutationParts.length });
  } catch (error) {
    console.error('Batch update failed:', error);
    res.status(500).json({ error: 'Batch update failed' });
  }
});

// --- 5. GET VIEWS ENDPOINT (lecture live depuis Shopify) ---
app.get('/api/get-views/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    if (!postId) return res.status(400).json({ error: 'Post ID is required' });

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
      return res.status(404).json({ success: false, error: 'Metaobject not found' });
    }

    const viewField = metaobject.fields.find(f => f.key === "view_count");
    const currentViewCount = parseInt(viewField?.value || "0", 10);

    res.status(200).json({ success: true, viewCount: currentViewCount });
  } catch (error) {
    console.error('Error fetching views:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- 6. HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('Bylanglois Views API (batch-enabled) is running.');
});

export default app;
