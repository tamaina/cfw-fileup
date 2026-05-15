<script setup lang="ts">
import { ref, onMounted } from 'vue';

const iframeRef = ref<HTMLIFrameElement>();

onMounted(async () => {
	try {
		// Fetch the OpenAPI spec
		const response = await fetch('/api/openapi.json');
		if (!response.ok) {
			throw new Error(`Failed to fetch API spec: ${response.statusText}`);
		}
		const spec = await response.json();

		// Create Swagger UI HTML
		const specStr = JSON.stringify(spec);
		const htmlContent = `
<!DOCTYPE html>
<html>
  <head>
    <title>CFW FileUp API Documentation</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4.20.0/swagger-ui.css">
    <style>
      html {
        box-sizing: border-box;
        overflow: -moz-scrollbars-vertical;
        overflow-y: scroll;
      }
      *, *:before, *:after {
        box-sizing: inherit;
      }
      body {
        margin:0;
        padding:0;
        font-family: sans-serif;
      }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4.20.0/swagger-ui-bundle.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4.20.0/swagger-ui-standalone-preset.js"></script>
    <script>
      const spec = ${specStr};
      window.onload = function() {
        const ui = SwaggerUIBundle({
          spec: spec,
          dom_id: '#swagger-ui',
          presets: [
            SwaggerUIBundle.presets.apis,
            SwaggerUIStandalonePreset
          ],
          plugins: [
            SwaggerUIBundle.plugins.DownloadUrl
          ],
          layout: 'StandaloneLayout',
          defaultModelsExpandDepth: 1,
          defaultModelExpandDepth: 1,
        });
        window.ui = ui;
      }
    </script>
  </body>
</html>
`;

		// Write HTML to iframe
		if (iframeRef.value) {
			iframeRef.value.srcdoc = htmlContent;
		}
	} catch (err) {
		console.error('Error loading API documentation:', err);
	}
});
</script>

<template>
	<div class="api-docs-container">
		<iframe
			ref="iframeRef"
			class="docs-iframe"
			title="API Documentation"
		></iframe>
	</div>
</template>

<style scoped>
.api-docs-container {
	width: 100%;
	height: 100vh;
	overflow: hidden;
}

.docs-iframe {
	width: 100%;
	height: 100%;
	border: none;
}</style>
