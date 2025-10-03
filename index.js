// This is the new, SECURE version of the setup code.

import express from 'express';
import cors from 'cors';
import { shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

// --- 1. SETUP ---
const app = express();
app.use(express.json());
app.use(cors());

// Initialize the Shopify API client using the SECURE environment variables
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY, // Reads from Vercel's vault
  apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY, // Reads from Vercel's vault
  scopes: ['write_metaobjects', 'read_metaobjects'],
  hostName: 'bylanglois.com', 
  isEmbeddedApp: false,
});

// This also uses the SECURE environment variable for your token.
const session = {
  shop: 'galerie-langlois.myshopify.com', 
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN, // Reads from Vercel's vault
};

const client = new shopify.clients.Graphql({ session });

// --- 2. THE API ENDPOINT ---
app.post('/api/increment-view', async (req, res) => {
  try {
    const { postId } = req.body;
    if (!postId) {
      return res.status(400).json({ error: 'Post ID is required' });
    }

    const findMetaobjectQuery = `
      query FindMetaobject($type: String!, $handle: String!) {
        metaobjectByHandle(type: $type, handle: { type: $type, handle: $handle }) {
          id
          view_count: field(key: "view_count") { value }
        }
      }
    `;
    
    const findResponse = await client.query({
      data: {
        query: findMetaobjectQuery,
        variables: { type: "custom_post_views", handle: postId },
      },
    });

    const metaobject = findResponse.body.data.metaobjectByHandle;
    if (!metaobject) {
      console.log(`Metaobject not found for postId: ${postId}`);
      return res.status(404).json({ error: 'Metaobject not found' });
    }

    const currentViewCount = parseInt(metaobject.view_count.value, 10);
    const newViewCount = currentViewCount + 1;
    const metaobjectId = metaobject.id;

    const updateMetaobjectMutation = `
      mutation UpdateMetaobject($id: ID!, $viewCount: String!) {
        metaobjectUpdate(
          id: $id,
          metaobject: { fields: [{ key: "view_count", value: $ViewCount }] }
        ) {
          metaobject { id }
          userErrors { field, message }
        }
      }
    `;

    const updateResponse = await client.query({
      data: {
        query: updateMetaobjectMutation,
        variables: { id: metaobjectId, viewCount: newViewCount.toString() },
      },
    });

    if (updateResponse.body.data.metaobjectUpdate.userErrors.length > 0) {
      throw new Error(updateResponse.body.data.metaobjectUpdate.userErrors.map(e => e.message).join(', '));
    }

    console.log(`Successfully incremented view for ${postId} to ${newViewCount}`);
    res.status(200).json({ success: true, newViewCount: newViewCount });

  } catch (error) {
    console.error('Failed to increment view count:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/', (req, res) => {
    res.send('Bylanglois Views API is running.');
});

export default app;