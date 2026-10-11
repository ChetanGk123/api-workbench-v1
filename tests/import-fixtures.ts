// R7 import documents shared by the pure and Chrome cases. Each targets the fixture echo routes so a
// representative imported endpoint can be sent and checked. `origin` is the fixture origin.

export const swaggerDoc = (origin: string) => {
  const u = new URL(origin);
  return {
    swagger: '2.0',
    info: { title: 'Pets (Swagger)', version: '1' },
    host: u.host, basePath: '/api', schemes: ['http'],
    consumes: ['application/json'],
    securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' }, oauth: { type: 'oauth2', flow: 'implicit', authorizationUrl: 'x', scopes: {} } },
    security: [{ key: [] }],
    definitions: {
      Pet: { type: 'object', example: { name: 'Rex', tag: 'dog' } },
      Loop: { $ref: '#/definitions/Loop2' },
      Loop2: { $ref: '#/definitions/Loop' },
    },
    parameters: { Limit: { name: 'limit', in: 'query', type: 'integer', default: 10 } },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets', summary: 'List pets',
          parameters: [{ $ref: '#/parameters/Limit' }, { name: 'tags', in: 'query', type: 'array', items: { type: 'string' }, collectionFormat: 'multi', 'x-example': ['a', 'b'] }, { name: 'sort', in: 'query', type: 'string' }],
          responses: { 200: { description: 'ok', examples: { 'application/json': [{ name: 'Rex' }] } } },
        },
        post: {
          operationId: 'createPet', summary: 'Create pet',
          parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }],
          responses: { 201: { description: 'created' } },
        },
      },
      '/pets/{petId}': {
        parameters: [{ name: 'petId', in: 'path', required: true, type: 'string' }],
        get: { operationId: 'getPet', responses: { 200: { description: 'ok' } }, security: [{ oauth: [] }] },
        delete: { operationId: 'getPet', parameters: [{ name: 'petId', in: 'path', required: true, type: 'string', 'x-example': 'p 1' }], responses: { 204: { description: 'gone' } }, security: [] },
      },
      '/pets/{petId}/photo': {
        post: {
          operationId: 'uploadPhoto', consumes: ['multipart/form-data'],
          parameters: [{ name: 'petId', in: 'path', required: true, type: 'string', 'x-example': '7' }, { name: 'caption', in: 'formData', type: 'string', 'x-example': 'hi' }, { name: 'file', in: 'formData', type: 'file', required: true }],
          responses: { 200: { description: 'ok' } },
        },
      },
      '/loops': { post: { operationId: 'loop', parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Loop' } }], responses: { 200: { description: 'ok' } } } },
      '/remote': { get: { operationId: 'remote', parameters: [{ $ref: 'https://example.invalid/params.json#/Limit' }], responses: { 200: { description: 'ok' } } } },
    },
  };
};

export const openapiDoc = (origin: string) => ({
  openapi: '3.0.3',
  info: { title: 'Shop (OpenAPI)', version: '1' },
  servers: [{ url: '{scheme}://{host}/api', variables: { scheme: { default: 'http' }, host: { default: new URL(origin).host } } }, { url: '/relative/api' }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, q: { type: 'apiKey', in: 'query', name: 'api_key' }, sess: { type: 'apiKey', in: 'cookie', name: 'sid' }, oidc: { type: 'openIdConnect', openIdConnectUrl: 'x' } },
    examples: { small: { value: { sku: 'A1', qty: 1, price: '100.10' } } },
    parameters: { Id: { name: 'id', in: 'path', required: true, schema: { type: 'string' } } },
    requestBodies: { Order: { required: true, content: {
      'application/json': { examples: { small: { $ref: '#/components/examples/small' }, big: { value: { sku: 'B2', qty: 500, price: '9.99' } } } },
      'application/x-www-form-urlencoded': { example: { sku: 'C3', qty: '2' } },
    } } },
  },
  security: [{ bearer: [] }],
  paths: {
    '/orders': {
      post: { operationId: 'createOrder', summary: 'Create order', security: [], requestBody: { $ref: '#/components/requestBodies/Order' }, responses: { 201: { description: 'ok', content: { 'application/json': { example: { id: 'o-1', status: 'new' } } } } } },
      get: { operationId: 'listOrders', parameters: [{ name: 'status', in: 'query', schema: { type: 'array', items: { type: 'string' } }, example: ['new', 'paid'] }, { name: 'filter', in: 'query', style: 'deepObject', schema: { type: 'object' }, example: { min: 1, max: 5 } }, { name: 'X-Trace', in: 'header', required: true, schema: { type: 'string' } }], security: [{ q: [] }], responses: { 200: { description: 'ok' } } },
    },
    '/orders/{id}': {
      parameters: [{ $ref: '#/components/parameters/Id' }],
      get: { operationId: 'getOrder', security: [{ sess: [] }], responses: { 200: { description: 'ok' } } },
      put: { operationId: 'replaceOrder', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, security: [{ oidc: [] }, { bearer: [] }], responses: { 200: { description: 'ok' } } },
    },
    '/orders/{id}/cancel': { post: { operationId: 'cancelOrder', parameters: [{ $ref: '#/components/parameters/Id' }], responses: { 204: { description: 'ok' } } } },
    '/files': {
      post: { operationId: 'upload', security: [], requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, doc: { type: 'string', format: 'binary' }, note: { type: 'string', example: 'n1' } } } } } }, responses: { 200: { description: 'ok' } } },
    },
  },
});

export const postmanDoc = (origin: string) => ({
  info: { _postman_id: 'r7', name: 'Bank (Postman)', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'baseUrl', value: origin }, { key: 'acct', value: 'ACC-9' }, { key: 'off', value: 'x', disabled: true }],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: 'collection-secret-token', type: 'string' }] },
  event: [{ listen: 'prerequest', script: { exec: ['pm.environment.set("ts", Date.now())'] } }],
  item: [
    {
      name: 'Accounts',
      variable: [{ key: 'acct', value: 'ACC-FOLDER' }],
      auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Bank-Key' }, { key: 'value', value: 'folder-secret' }, { key: 'in', value: 'header' }] },
      item: [
        {
          name: 'Get account',
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.be.ok)'] } }],
          request: { method: 'GET', header: [{ key: 'X-Trace', value: 'acct-{{acct}}' }, { key: 'X-Off', value: '1', disabled: true }], url: { raw: '{{baseUrl}}/api/accounts/:id?expand=1&skip=1', host: ['{{baseUrl}}'], path: ['api', 'accounts', ':id'], query: [{ key: 'expand', value: '1' }, { key: 'skip', value: '1', disabled: true }], variable: [{ key: 'id', value: '{{acct}}' }] } },
          response: [{ name: 'ok', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{"id":"ACC-FOLDER"}' }],
        },
        { name: 'Public rates', request: { method: 'GET', auth: { type: 'noauth' }, header: [], url: '{{baseUrl}}/api/rates' } },
      ],
    },
    {
      name: 'Transfers',
      item: [
        { name: 'Create transfer', request: { method: 'POST', header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Idempotency-Key', value: '{{$guid}}' }], body: { mode: 'raw', raw: '{"from":"{{acct}}","amount":"10.00","memo":"{{memo}}"}', options: { raw: { language: 'json' } } }, url: '{{baseUrl}}/api/transfers' } },
        { name: 'Upload statement', request: { method: 'POST', header: [], body: { mode: 'formdata', formdata: [{ key: 'kind', value: 'pdf', type: 'text' }, { key: 'file', type: 'file', src: '/Users/someone/statement.pdf' }, { key: 'old', value: 'x', type: 'text', disabled: true }] }, url: '{{baseUrl}}/api/statements' } },
        { name: 'Search', request: { method: 'POST', header: [], body: { mode: 'graphql', graphql: { query: 'query { accounts { id } }', variables: '{"n": 1}' } }, url: '{{baseUrl}}/api/graphql' } },
        { name: 'Login form', request: { method: 'POST', auth: { type: 'basic', basic: [{ key: 'username', value: 'ana' }, { key: 'password', value: 'pw-secret' }] }, header: [], body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'ana' }, { key: 'remember', value: '1' }, { key: 'skip', value: '1', disabled: true }] }, url: '{{baseUrl}}/api/login-form' } },
        { name: 'Signed (hawk)', request: { method: 'GET', auth: { type: 'hawk', hawk: [] }, header: [], url: '{{otherBase}}/api/signed' } },
      ],
    },
  ],
});
