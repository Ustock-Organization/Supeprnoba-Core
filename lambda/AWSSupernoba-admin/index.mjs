import { Kafka } from 'kafkajs';
import { generateAuthToken } from 'aws-msk-iam-sasl-signer-js';
async function createKafkaClient() {
  const region = 'ap-northeast-2';
  
  return new Kafka({
    clientId: 'msk-admin',
    brokers: process.env.MSK_BOOTSTRAP_SERVERS.split(','),
    ssl: true,
    sasl: {
      mechanism: 'oauthbearer',
      oauthBearerProvider: async () => {
        const token = await generateAuthToken({ region });
        return { value: token.token };
      },
    },
  });
}
export const handler = async (event) => {
  try {
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body || event;
    }
    
    const { action, topic, partitions = 3, replicationFactor = 2 } = body;
    
    const kafka = await createKafkaClient();
    const admin = kafka.admin();
    await admin.connect();
    
    let result;
    
    switch (action) {
      case 'listTopics':
        result = await admin.listTopics();
        break;
        
      case 'createTopic':
        if (!topic) throw new Error('topic is required');
        await admin.createTopics({
          topics: [{ topic, numPartitions: partitions, replicationFactor }],
        });
        result = { created: topic };
        break;
        
      case 'deleteTopic':
        if (!topic) throw new Error('topic is required');
        await admin.deleteTopics({ topics: [topic] });
        result = { deleted: topic };
        break;
        
      case 'describeTopic':
        if (!topic) throw new Error('topic is required');
        result = await admin.fetchTopicMetadata({ topics: [topic] });
        break;
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    await admin.disconnect();
    
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, result }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};