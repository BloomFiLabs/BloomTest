import 'dotenv/config';
import axios from 'axios';

const SUBGRAPH_ID = 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk';
const API_KEY = process.env.THE_GRAPH_API_KEY;

async function main() {
  const url = `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${SUBGRAPH_ID}`;
  
  const query = `
    {
      __schema {
        queryType {
          fields {
            name
          }
        }
      }
    }
  `;

  try {
    const response = await axios.post(url, { query });
    const fields = response.data.data.__schema.queryType.fields;
    console.log('Available Query Fields:');
    console.log(fields.map((f: any) => f.name).join(', '));
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

main();
