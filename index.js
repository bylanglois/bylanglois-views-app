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

// --- 2. ENDPOINT: INCREMENT (déjà existant) ---
app.post('/api/increment-view', async (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ error: 'Post ID is required' });

    // Find metaobject
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
    const newViewCount = currentViewCount + 1;

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

    await client.query({
      data: {
        query: updateMetaobjectMutation,
        variables: { id: metaobject.id, viewCount: newViewCount.toString() },
      },
    });

    res.status(200).json({ success: true, newViewCount });
  } catch (error) {
    console.error('Error incrementing view:', error);
    res.status(500).json({ error: 'Internal Server Error' });
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

    res.status(200).json({ success: true, currentViewCount });
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
