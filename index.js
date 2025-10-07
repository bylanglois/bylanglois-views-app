// --- 1. SETUP ---
import express from 'express';
import cors from 'cors';
import { shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

const app = express();
app.use(express.json());
app.use(cors());

// --- Shopify API Client Setup (same as before) ---
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


// --- 2. THE BATCHING MECHANISM ---
// This is our temporary storage for view counts.
// IMPORTANT: For a production app, this simple in-memory map will reset when your
// Vercel function goes to sleep. You should replace this with a proper
// persistent store like Vercel KV, Upstash Redis, or Vercel Postgres.
// For now, this demonstrates the logic.
const pendingUpdates = new Map();


// --- 3. REVISED ENDPOINT: INCREMENT (Now super fast!) ---
// This endpoint NO LONGER talks to Shopify. It's now incredibly fast and cheap.
app.post('/api/increment-view', async (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) {
      return res.status(400).json({ error: 'Post ID is required' });
    }

    // Get the current pending count for this post, or start at 0
    const currentCount = pendingUpdates.get(postId) || 0;
    // Increment the count in our temporary storage
    pendingUpdates.set(postId, currentCount + 1);

    console.log(`View for ${postId} received. Total pending: ${pendingUpdates.get(postId)}`);

    // Respond with "202 Accepted". This tells the browser "I got it, but I'm processing it later."
    res.status(202).json({ success: true, message: 'View accepted for batch processing.' });

  } catch (error) {
    console.error('Error recording view to internal cache:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// --- 4. NEW ENDPOINT: PROCESS BATCH (The heavy lifter) ---
// This endpoint will be called by a cron job every 5 minutes.
// It will send ALL pending updates to Shopify in a single API call.
app.post('/api/process-batch', async (req, res) => {
  // Add a simple layer of security to ensure only your cron job can run this.
  const cronSecret = req.headers['x-cron-secret'];
  if (cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // If there are no views to update, do nothing.
  if (pendingUpdates.size === 0) {
    console.log('Batch processor ran, but no pending updates.');
    return res.status(200).json({ success: true, message: 'No pending updates to process.' });
  }

  console.log(`Processing batch of ${pendingUpdates.size} updates...`);
  
  // Create a copy of the pending updates and clear the original immediately.
  // This prevents race conditions where a new view comes in while we're processing.
  const updatesToProcess = new Map(pendingUpdates);
  pendingUpdates.clear();

  try {
    // Step 1: Fetch ALL metaobjects in one go (same as before, but done once per batch)
    const findMetaobjectQuery = `
      query GetMetaobjectsForBatchUpdate {
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

    // Step 2: Prepare the updates
    const updatesPayload = [];
    for (const [postId, viewsToAdd] of updatesToProcess.entries()) {
      const metaobject = allMetaobjects.find(node =>
        node.fields.some(f => f.key === "post_id" && f.value === postId)
      );

      if (metaobject) {
        const viewField = metaobject.fields.find(f => f.key === "view_count");
        const currentViewCount = parseInt(viewField?.value || "0", 10);
        const newTotalViewCount = currentViewCount + viewsToAdd;
        
        updatesPayload.push({
          id: metaobject.id,
          viewCount: newTotalViewCount.toString()
        });
      }
    }
    
    // If we have nothing to update after filtering, exit.
    if (updatesPayload.length === 0) {
        console.log("Batch processing finished. No matching metaobjects found for pending updates.");
        return res.status(200).json({ success: true, message: "No metaobjects to update." });
    }

    // Step 3: Build a SINGLE GraphQL mutation with aliases to update all metaobjects at once
    const mutationParts = updatesPayload.map((payload, index) => 
        `
        update_${index}: metaobjectUpdate(
            id: "${payload.id}",
            metaobject: { fields: [{ key: "view_count", value: "${payload.viewCount}" }] }
        ) {
            metaobject { id }
            userErrors { field message }
        }
        `
    ).join('\n');
    
    const combinedMutation = `mutation BatchUpdateMetaobjects { ${mutationParts} }`;

    // Step 4: Execute the single, combined API call
    await client.query({ data: { query: combinedMutation } });
    
    console.log(`Successfully processed and updated ${updatesPayload.length} metaobjects in Shopify.`);
    res.status(200).json({ success: true, message: `Batch of ${updatesPayload.length} updates processed.` });

  } catch (error) {
    console.error('Error processing batch update:', error);
    // If it fails, you might want to re-add the updates to the pending queue
    // This is more advanced error handling (retries)
    res.status(500).json({ error: 'Failed to process batch update.' });
  }
});


// --- 5. GET VIEWS ENDPOINT (Unchanged, but be aware of caching) ---
// This endpoint remains the same. Note that it will now return the count from Shopify,
// which might be a few minutes out of date from the *absolute* real-time count.
// This is a healthy trade-off for a stable system.
app.get('/api/get-views/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    if (!postId) return res.status(400).json({ error: 'Post ID is required' });

    // This part is still inefficient but less critical than the increment endpoint.
    // For a future optimization, consider creating a lookup table to get a metaobject ID directly.
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
      return res.status(200).json({ success: true, currentViewCount: 0 }); // Return 0 if not found
    }

    const viewField = metaobject.fields.find(f => f.key === "view_count");
    const currentViewCount = parseInt(viewField?.value || "0", 10);

    res.status(200).json({ success: true, currentViewCount: currentViewCount });
  } catch (error) {
    console.error('Error fetching views:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// --- 6. HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('Bylanglois Views API (Batching Version) is running.');
});

export default app;
