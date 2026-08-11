import Fastify from 'fastify';

// Disable internal logging during load tests to maximize throughput
const fastify = Fastify({ logger: false });

// Handles incoming MCP JSON-RPC calls
fastify.post('/mcp', async (request, reply) => {
  const { id } = (request.body as { id?: unknown } | undefined) ?? {};

  // Standard MCP / JSON-RPC 2.0 response format
  return {
    jsonrpc: '2.0',
    id: id ?? 1,
    result: {
      content: [
        {
          type: 'text',
          text: 'Mock tool execution succeeded',
        },
      ],
    },
  };
});

const start = async () => {
  try {
    // Listen on 0.0.0.0 to allow localhost and local tunnel binding
    await fastify.listen({ port: 8080, host: '0.0.0.0' });
    console.log('Mock MCP Server listening on http://0.0.0.0:8080');
  } catch (err) {
    console.error('Failed to start mock server:', err);
    process.exit(1);
  }
};

start();