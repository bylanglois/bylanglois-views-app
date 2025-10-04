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

// --- 2. ENDPOINT: INCREMENT ---
app.post('/api/increment-view', async (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ error: 'Post ID is required' });

    // Step 1: Fetch ALL metaobjects
    const findMetaobjectQuery = `
      query {
        metaobjects(type: "custom_post_views", first: 50) {
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

    // Step 2: Filter manually for the correct post_id
    const metaobject = allMetaobjects.find(node =>
      node.fields.some(f => f.key === "post_id" && f.value === postId)
    );

    if (!metaobject) {
      return res.status(404).json({ success: false, error: 'Metaobject not found' });
    }

    // Step 3: Increment count
    const viewField = metaobject.fields.find(f => f.key === "view_count");
    const currentViewCount = parseInt(viewField?.value || "0", 10);
    const newViewCount = currentViewCount + 1;

    // Step 4: Update ONLY view_count
    const updateMetaobjectMutation = `
      mutation UpdateMetaobject($id: ID!, $viewCount: String!) {
        metaobjectUpdate(
          id: $id,
          metaobject: { fields: [{ key: "view_count", value: $viewCount }] }
        ) {
          metaobject { id }
          userErrors { field, message }
        }
      }
    `;

    const updateResponse = await client.query({
      data: {
        query: updateMetaobjectMutation,
        variables: { id: metaobject.id, viewCount: newViewCount.toString() },
      },
    });

    const userErrors = updateResponse.body.data.metaobjectUpdate.userErrors;
    if (userErrors.length > 0) {
      console.error("Shopify update error:", userErrors);
      return res.status(500).json({ success: false, error: 'Failed to update view count' });
    }

    res.status(200).json({ success: true, newViewCount });
  } catch (error) {
    console.error('Error incrementing view:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- 3. ENDPOINT: GET VIEWS ---
app.get('/api/get-views/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    if (!postId) return res.status(400).json({ error: 'Post ID is required' });

    const findMetaobjectQuery = `
      query {
        metaobjects(type: "custom_post_views", first: 50) {
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

// --- 4. NEW ENDPOINT: GET ALL VIEWS ---
app.get('/api/get-all-views', async (req, res) => {
  try {
    // Fetch ALL metaobjects of type custom_post_views
    const findMetaobjectQuery = `
      query {
        metaobjects(type: "custom_post_views", first: 50) {
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

// --- 5. HEALTH CHECK ---
app.get('/', (req, res) => {
  res.send('Bylanglois Views API is running.');
});

export default app;
