// --- 1. SETUP ---
import express from 'express';
import cors from 'cors';
import { shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

// A simple console log to confirm in Vercel that the correct version is running
console.log("--- BYLANGLOIS BATCHING SERVER v2.2 (Corrected) ---");

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
  // THIS LINE IS NOW CORRECTED
  shop: 'galerie-langlois.myshopify.com',
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
};

const client = new shopify.clients.Graphql({ session });

// --- 2. IN-MEMORY CACHE (The Batch Buffer) ---
const pendingUpdates = new Map();

// --- 3. FAST INCREMENT ENDPOINT ---
app.post('/api/increment-view', async (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ error: 'Post ID is required' });

    const current = pendingUpdates.get(postId) || 0;
    pendingUpdates.set(postId, current + 1);

    console.log(`Queued +1 for postId=${postId}, pending total=${pendingUpdates.get(postId)}`);

    res.status(202).json({ success: true, message: 'View queued for batch update' });
  } catch (error) {
    console.error('Error queuing view (cache):', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- 4. BATCH PROCESSING ENDPOINT (Triggered by Cron) ---
app.post('/api/process-batch', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (cronSecret !== process.env.CRON_SECRET) {
    console.warn("Unauthorized cron attempt detected.");
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (pendingUpdates.size === 0) {
    console.log('Cron job ran: No pending views to update.');
    return res.status(200).json({ success: true, message: 'Nothing to process' });
  }

  const updatesToProcess = new Map(pendingUpdates);
  pendingUpdates.clear();

  try {
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
      console.log('Cron job ran: Views were queued but no matching metaobjects found.');
      return res.status(200).json({ success: true, message: 'No matching metaobjects' });
    }

    const combinedMutation = `mutation { ${mutationParts.join('\n')} }`;
    await client.query({ data: { query: combinedMutation } });

    console.log(`BATCH UPDATE SUCCESS: Processed ${mutationParts.length} posts.`);
    res.status(200).json({ success: true, updated: mutationParts.length });
  } catch (error) {
    console.error('CRON JOB FAILED:', error.message);
    res.status(500).json({ error: 'Batch update failed' });
  }
});

// --- 5. GET ALL VIEWS ENDPOINT ---
app.get('/api/get-all-views', async (req, res) => {
  try {
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
    
    const views = {};
    allMetaobjects.forEach(node => {
        const postIdField = node.fields.find(f => f.key === "post_id");
        const viewCountField = node.fields.find(f => f.key === "view_count");
        if(postIdField && viewCountField) {
            views[postIdField.value] = parseInt(viewCountField.value || "0", 10);
        }
    });

    res.status(200).json({ success: true, views });
  } catch (error) {
    console.error('Error fetching all views:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});


// --- 6. HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('Bylanglois Views API (batch-enabled) is running.');
});

export default app;
// --- 6. HEALTH CHECK ---


