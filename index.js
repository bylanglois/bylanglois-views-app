// This is the FINAL, corrected, and customized code for index.js

import express from 'express';
import cors from 'cors';
import { shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

// --- 1. SETUP ---
const app = express();
app.use(express.json());
app.use(cors());

// Initialize the Shopify API client using SECURE environment variables
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY,
  scopes: ['write_metaobjects', 'read_metaobjects'],
  hostName: 'bylanglois.com', 
  isEmbeddedApp: false,
});

// This uses your SECURE environment variables
const session = {
  shop: 'galerie-langlois.myshopify.com',
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
};

const client = new shopify.clients.Graphql({ session });

// --- 2. THE API ENDPOINT ---
app.post('/api/increment-view', async (req, res) => {
  console.log('Request received for /api/increment-view'); // New log for debugging
  try {
    const { postId } = req.body;
    if (!postId) {
      return res.status(400).json({ error: 'Post ID is required' });
    }
    console.log(`Processing view for postId: ${postId}`); // New log

    // --- THIS QUERY IS NOW CORRECTED ---
    const findMetaobjectQuery = `
      query FindMetaobject($handle: String!) {
        metaobjectByHandle(type: "custom_post_views", handle: $handle) {
          id
          view_count: field(key: "view_count") { value }
        }
      }
    `;
    
    const findResponse = await client.query({
      data: {
        query: findMetaobjectQuery,
        variables: { handle: postId }, // Corrected variable structure
      },
    });

    const metaobject = findResponse.body.data.metaobjectByHandle;
    if (!metaobject) {
      const errorMessage = `Metaobject not found for postId: ${postId}`;
      console.error(errorMessage);
      return res.status(404).json({ error: errorMessage });
    }

    const currentViewCount = parseInt(metaobject.view_count.value, 10);
    const newViewCount = currentViewCount + 1;
    const metaobjectId = metaobject.id;
    console.log(`Updating count from ${currentViewCount} to ${newViewCount}`); // New log

    // --- THIS MUTATION IS NOW CORRECTED ---
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
        variables: { id: metaobjectId, viewCount: newViewCount.toString() },
      },
    });

    const userErrors = updateResponse.body.data.metaobjectUpdate.userErrors;
    if (userErrors.length > 0) {
      const errorMessage = userErrors.map(e => e.message).join(', ');
      console.error('Shopify API User Errors:', errorMessage);
      throw new Error(errorMessage);
    }

    console.log(`Successfully incremented view for ${postId} to ${newViewCount}`);
    res.status(200).json({ success: true, newViewCount: newViewCount });

  } catch (error) {
    console.error('--- DETAILED ERROR CATCH ---');
    console.error('Error Message:', error.message);
    console.error('Full Error:', JSON.stringify(error, null, 2));
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/', (req, res) => {
    res.send('Bylanglois Views API is running.');
});

export default app;