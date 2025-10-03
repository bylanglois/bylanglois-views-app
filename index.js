// This is your final, customized code for index.js

import express from 'express';
import cors from 'cors';
import { shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

// --- 1. SETUP ---
const app = express();
app.use(express.json());
app.use(cors());

// Initialize the Shopify API client
const shopify = shopifyApi({
  // You need to get these two from your custom app's settings page in Shopify
  apiKey: '02965f9492dcb0d4224c9c2f6da882fe', 
  apiSecretKey: '45dc58d3f686c2aeb8d4db25fd343624', 
  scopes: ['write_metaobjects', 'read_metaobjects'],
  hostName: 'bylanglois.com', 
  isEmbeddedApp: false,
});

// This uses your credentials directly from the script you provided.
const session = {
  shop: 'galerie-langlois.myshopify.com', // Filled in from your script
  accessToken: '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', // Filled in from your script
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