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
  hostName: 'galerie-langlois.myshopify.com', 
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
  console.log('Request received for /api/increment-view');
  try {
    const { postId } = req.body;
    if (!postId) {
      return res.status(400).json({ error: 'Post ID is required' });
    }
    console.log(`Processing view for postId: ${postId}`);

    // --- FIND METAOBJECT BY post_id FIELD ---
    const findMetaobjectQuery = `
      query FindMetaobject($postId: String!) {
        metaobjects(type: "custom_post_views", first: 1, query: "post_id:$postId")
 {
          edges {
            node {
              id
              fields {
                key
                value
              }
            }
          }
        }
      }
    `;

    const findResponse = await client.query({
      data: {
        query: findMetaobjectQuery,
        variables: { postId },
      },
    });

    console.log("FindResponse:", JSON.stringify(findResponse.body, null, 2));

    const edges = findResponse.body.data.metaobjects.edges;
    if (edges.length === 0) {
      const errorMessage = `Metaobject not found for postId: ${postId}`;
      console.error(errorMessage);
      return res.status(404).json({ error: errorMessage });
    }

    const metaobject = edges[0].node;
    const viewField = metaobject.fields.find(f => f.key === "view_count");
    const currentViewCount = parseInt(viewField?.value || "0", 10);
    const newViewCount = currentViewCount + 1;
    const metaobjectId = metaobject.id;

    console.log(`Updating count from ${currentViewCount} to ${newViewCount}`);

    // --- UPDATE METAOBJECT ---
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

    console.log("UpdateResponse:", JSON.stringify(updateResponse.body, null, 2));

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

// Simple health check
app.get('/', (req, res) => {
  res.send('Bylanglois Views API is running.');
});

export default app;
