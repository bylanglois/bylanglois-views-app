// --- 1. SETUP (déjà existant) ---
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

// --- 2. ENDPOINT: INCREMENT (FINAL, CORRECTED VERSION) ---
app.post('/api/increment-view', async (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ error: 'Post ID is required' });

    // Step 1: Find the metaobject by its post_id field
    const findMetaobjectQuery = `
      query FindMetaobject($query: String!) {
        metaobjects(type: "custom_post_views", first: 1, query: $query) {
          edges {
            node {
              id
              fields { key value }
            }
          }
        }
      }
    `;

    const findResponse = await client.query({
      data: {
        query: findMetaobjectQuery,
        variables: { query: `post_id:${postId}` },
      },
    });

    const edges = findResponse.body.data.metaobjects.edges;
    if (edges.length === 0) {
      return res.status(404).json({ success: false, error: 'Metaobject not found' });
    }

    const metaobject = edges[0].node;
    
    // Step 2: Calculate the new view count
    const viewField = metaobject.fields.find(f => f.key === "view_count");
    const currentViewCount = parseInt(viewField?.value || "0", 10);
    const newViewCount = currentViewCount + 1;

    // Step 3: Prepare fields for update, EXCLUDING any fields that are null or empty.
    // This is the critical fix. Shopify's API rejects updates that include fields with null values.
    const fieldsForUpdate = metaobject.fields
      .filter(field => field.key !== 'view_count' && field.value != null && field.value !== '')
      .map(field => ({
        key: field.key,
        value: field.value,
      }));

    // Add the updated view_count to the list of fields to be sent.
    fieldsForUpdate.push({ key: 'view_count', value: newViewCount.toString() });

    // Step 4: Send the update mutation to Shopify
    const updateMetaobjectMutation = `
      mutation UpdateMetaobject($id: ID!, $fields: [MetaobjectFieldInput!]!) {
        metaobjectUpdate(
          id: $id,
          metaobject: { fields: $fields }
        ) {
          metaobject { id }
          userErrors { field, message }
        }
      }
    `;

    const updateResponse = await client.query({
      data: {
        query: updateMetaobjectMutation,
        variables: {
          id: metaobject.id,
          fields: fieldsForUpdate,
        },
      },
    });

    if (updateResponse.body.data.metaobjectUpdate.userErrors.length > 0) {
      console.error('Shopify API Error during update:', updateResponse.body.data.metaobjectUpdate.userErrors);
      // Even if it fails, return the old count so the frontend doesn't show 0
      return res.status(500).json({ success: false, error: 'Failed to update metaobject', newViewCount: currentViewCount });
    }

    res.status(200).json({ success: true, newViewCount });
  } catch (error) {
    console.error('Full error in /api/increment-view:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});


// --- 3. NOUVEL ENDPOINT: GET VIEWS ---
app.get('/api/get-views/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    if (!postId) return res.status(400).json({ error: 'Post ID is required' });

    const findMetaobjectQuery = `
      query FindMetaobject($query: String!) {
        metaobjects(type: "custom_post_views", first: 1, query: $query) {
          edges {
            node {
              id
              fields { key value }
            }
          }
        }
      }
    `;

    const findResponse = await client.query({
      data: {
        query: findMetaobjectQuery,
        variables: { query: `post_id:${postId}` },
      },
    });

    const edges = findResponse.body.data.metaobjects.edges;
    if (edges.length === 0) return res.status(404).json({ error: 'Metaobject not found' });

    const metaobject = edges[0].node;
    const viewField = metaobject.fields.find(f => f.key === "view_count");
    const currentViewCount = parseInt(viewField?.value || "0", 10);

    // Corrected the key to match what the frontend expects
    res.status(200).json({ success: true, currentViewCount: currentViewCount });

  } catch (error) {
    console.error('Error fetching views:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- 4. HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('Bylanglois Views API is running.');
});

export default app;

