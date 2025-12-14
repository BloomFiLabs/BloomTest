import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const GMX_SUBGRAPH_ID = 'F8JuJQQuDYoXkM3ngneRnrL9RA7sT5DjL6kBZE1nJZc3';
const SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${GMX_SUBGRAPH_ID}`;

async function introspect() {
  const apiKey = process.env.THE_GRAPH_API_KEY;

  console.log('🔍 Introspecting GMX Subgraph Schema\n');

  const introspectionQuery = `
    query {
      __schema {
        queryType {
          fields {
            name
            type {
              name
              kind
            }
          }
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      { query: introspectionQuery },
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (response.data.errors) {
      console.log('❌ Introspection failed:', response.data.errors[0].message);
    } else {
      const fields = response.data.data.__schema.queryType.fields;
      console.log(`✅ Found ${fields.length} queryable entities\n`);
      
      console.log('Available Queries (showing names only):');
      console.log('─'.repeat(80));
      
      const relevantFields = fields.filter((f: any) => 
        !f.name.startsWith('_') && 
        (f.name.toLowerCase().includes('market') ||
         f.name.toLowerCase().includes('funding') ||
         f.name.toLowerCase().includes('trade') ||
         f.name.toLowerCase().includes('price') ||
         f.name.toLowerCase().includes('candle') ||
         f.name.toLowerCase().includes('fee'))
      );
      
      relevantFields.forEach((f: any) => {
        console.log(`  - ${f.name}`);
      });
      
      console.log('\n\nAll available queries:');
      console.log('─'.repeat(80));
      fields.filter((f: any) => !f.name.startsWith('_')).slice(0, 30).forEach((f: any) => {
        console.log(`  - ${f.name}`);
      });
      if (fields.length > 30) {
        console.log(`  ... and ${fields.length - 30} more`);
      }
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
}

introspect();
