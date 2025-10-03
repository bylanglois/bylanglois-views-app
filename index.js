// FINAL robust index.js — pagine et filtre côté serveur (pas de query par champ)

import express from 'express';
import cors from 'cors';
import { shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

const app = express();

// CORS : autorise ton site + l'URL Vercel du backend
app.use(cors({
  origin: [
    'https://bylanglois.com',
    'https://www.bylanglois.com',
    'https://bylanglois-views-app.vercel.app'
  ],
}));
app.use(express.json());

// Shopify Admin API (scopes requis: read_metaobjects, write_metaobjects)
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY,
  // Si tu préfères: scopes: process.env.SHOPIFY_API_SCOPES.split(','),
  scopes: ['write_metaobjects', 'read_metaobjects'],
  hostName: 'galerie-langlois.myshopify.com',
  isEmbeddedApp: false,
});

const session = {
  shop: 'galerie-langlois.myshopify.com',
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN, // Admin API access token
};

const client = new shopify.clients.Graphql({ session });

/**
 * Helper: paginate all metaobjects of a given type and find one by field key/value
 */
async function findMetaobjectByField({ type, fieldKey, fieldValue }) {
  const query = `
    query ListMetaobjects($first: Int!, $after: String) {
      metaobjects(type: "${type}", first: $first, after: $after) {
        pageInfo { hasNextPage, endCursor }
        edges {
          node {
            id
            fields { key value }
          }
        }
      }
    }
  `;

  let after = null;
  const pageSize = 50;

  // boucle pagination
  for (let i = 0; i < 200; i++) { // garde-fou
    const resp = await client.query({
      data: { query, variables: { first: pageSize, after } },
    });

    const payload = resp.body?.data?.metaobjects;
    if (!payload) break;

    for (const edge of payload.edges) {
      const node = edge.node;
      const match = node.fields.find(f => f.key === fieldKey && f.value === fieldValue);
      if (match) return node; // trouvé !
    }

    if (!payload.pageInfo.hasNextPage) break;
    after = payload.pageInfo.endCursor;
  }

  return null;
}

app.post('/api/increment-view', async (req, res) => {
  console.log('Request received for /api/increment-view');
  try {
    const { postId } = req.body;
    if (!postId) {
      return res.status(400).json({ error: 'Post ID is required' });
    }
    console.log(`Processing view for postId: ${postId}`);

    // 1) trouver le metaobject correspondant (type custom_post_views, champ post_id == postId)
    const metaobject = await findMetaobjectByField({
      type: 'custom_post_views',
      fieldKey: 'post_id',
      fieldValue: postId,
    });

    if (!metaobject) {
      const msg = `Metaobject not found for postId: ${postId}`;
      console.error(msg);
      return res.status(404).json({ error: msg });
    }

    // 2) lire le view_count courant
    const viewField = metaobject.fields.find(f => f.key === 'view_count');
    const currentViewCount = parseInt(viewField?.value ?? '0', 10);
    const newViewCount = isNaN(currentViewCount) ? 1 : currentViewCount + 1;

    console.log(`Updating count from ${currentViewCount} to ${newViewCount}`);

    // 3) faire l’update
    const updateMutation = `
      mutation UpdateMetaobject($id: ID!, $viewCount: String!) {
        metaobjectUpdate(
          id: $id,
          metaobject: { fields: [{ key: "view_count", value: $viewCount }] }
        ) {
          metaobject { id }
          userErrors { field message }
        }
      }
    `;

    const updateResp = await client.query({
      data: {
        query: updateMutation,
        variables: { id: metaobject.id, viewCount: String(newViewCount) },
      },
    });

    const errors = updateResp.body?.data?.metaobjectUpdate?.userErrors ?? [];
    if (errors.length) {
      const msg = errors.map(e => `${e.field?.join('.') || 'field'}: ${e.message}`).join(' | ');
      console.error('Shopify userErrors:', msg);
      return res.status(400).json({ error: msg });
    }

    console.log(`Successfully incremented view for ${postId} to ${newViewCount}`);
    return res.status(200).json({ success: true, newViewCount });

  } catch (error) {
    // logs utiles
    console.error('--- ERROR ---');
    console.error('Message:', error?.message);
    console.error('Stack:', error?.stack);
    // Certaines libs mettent les détails ici:
    console.error('Raw Error:', JSON.stringify(error, null, 2));
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// health check
app.get('/', (_req, res) => res.send('Bylanglois Views API is running.'));

export default app;
