// --- 1. SETUP ---
import express from 'express';
import cors from 'cors';
import { shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

// A simple console log to confirm in Vercel that the correct version is running
console.log("--- BYLANGLOIS BATCHING SERVER v2.3 (Vercel Cron FIXED) ---");

const app = express();
app.use(express.json());
app.use(cors());

// Shopify setup
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
app.all('/api/process-batch', async (req, res) => {
  const userAgent = req.headers['user-agent'] || '';
  const cronSecret = req.headers['x-cron-secret'];

  // Allow requests from Vercel Cron automatically
  if (!userAgent.includes('vercel-cron')) {
    if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
      console.warn("Unauthorized non-cron attempt detected.");
      return res.status(401).json({ error: 'Unauthorized' });
    }
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
      if (postIdField && viewCountField) {
        views[postIdField.value] = parseInt(viewCountField.value || "0", 10);
      }
    });

    res.status(200).json({ success: true, views });
  } catch (error) {
    console.error('Error fetching all views:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});
// --- NEW: POPULAR / TRENDING PROCESSOR (runs hourly) ---
app.all('/api/process-popular', async (req, res) => {
  console.log("🚀 Running POPULAR RANKING processor...");

  try {
    // 1. Fetch all metaobjects
    const queryMeta = `
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

    const response = await client.query({ data: { query: queryMeta } });
    const allMeta = response.body.data.metaobjects.edges.map(e => e.node);

    let mutationParts = [];
    let alias = 0;

    for (const meta of allMeta) {
      const fields = Object.fromEntries(meta.fields.map(f => [f.key, f.value]));

      const postId = fields.post_id;
      const viewCount = parseInt(fields.view_count || "0", 10);
      const prevCount = parseInt(fields.previous_view_count || "0", 10);

      // If this is the first time, we can’t compute last hour
      const viewsLastHour = Math.max(viewCount - prevCount, 0);

      // Store new previous count (snapshot)
      const newPrevCount = viewCount;

      // OPTIONAL : assign popular rank later in Liquid
      // but we still store views_last_hour

      mutationParts.push(`
        update_${alias++}: metaobjectUpdate(
          id: "${meta.id}",
          metaobject: {
            fields: [
              { key: "views_last_hour", value: "${viewsLastHour}" },
              { key: "previous_view_count", value: "${newPrevCount}" }
            ]
          }
        ) {
          metaobject { id }
          userErrors { field message }
        }
      `);
    }

    if (mutationParts.length === 0) {
      console.log("No metaobjects to update.");
      return res.status(200).json({ success: true, message: "Nothing to update" });
    }

    const fullMutation = `mutation { ${mutationParts.join("\n")} }`;
    await client.query({ data: { query: fullMutation } });

    console.log(`🔥 POPULAR UPDATE COMPLETE. Updated ${mutationParts.length} posts.`);

    res.status(200).json({
      success: true,
      updated: mutationParts.length
    });

  } catch (err) {
    console.error("❌ POPULAR processor error:", err);
    res.status(500).json({ error: "Failed to run popular processor" });
  }
});

// --- 6. HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('Bylanglois Views API (batch-enabled) is running.');
});

export default app;

