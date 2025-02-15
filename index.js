const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const { request } = require('@esri/arcgis-rest-request');
const nlp = require('compromise');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_PORTAL_URL =
  process.env.ESRI_PORTAL_URL ||
  'https://portal.spatial.nsw.gov.au/server/rest/services';

// Helper functions for availability status (server-side for table view)
function getAvailabilityColor(responseTime) {
  const rt = parseFloat(responseTime);
  if (isNaN(rt)) return "black";
  if (rt < 500) return "green";
  else if (rt < 1000) return "orange";
  else return "red";
}
function getAvailabilityStatus(responseTime) {
  const color = getAvailabilityColor(responseTime);
  if (color === 'green') return 'Good';
  else if (color === 'orange') return 'Warning';
  else if (color === 'red') return 'Problem';
  return 'Available';
}

// Simple in-memory cache with TTL (5 minutes)
const cache = {};
const CACHE_TTL = 5 * 60 * 1000;
function getFromCache(key) {
  const cached = cache[key];
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) return cached.value;
  return null;
}
function setToCache(key, value) {
  cache[key] = { value, timestamp: Date.now() };
}

// Axios interceptors for timing.
axios.interceptors.request.use((config) => {
  config.headers['request-startTime'] = new Date().getTime();
  return config;
});
axios.interceptors.response.use((response) => {
  const currentTime = new Date().getTime();
  response.headers['request-duration'] =
    currentTime - response.config.headers['request-startTime'];
  return response;
});

// Fetch services with caching.
async function fetchServices(url) {
  const cacheKey = `services_${url}`;
  const cachedData = getFromCache(cacheKey);
  if (cachedData) return cachedData;
  try {
    const response = await axios.get(url, { params: { f: 'json' } });
    setToCache(cacheKey, response.data);
    return response.data;
  } catch (error) {
    console.error(`Error fetching services: ${error.message}`);
    return null;
  }
}

// Fetch metadata summary. If no initialExtent exists and the service is a FeatureServer,
// try querying the first layer for its extent.
async function fetchMetadataSummary(serviceUrl) {
  const cacheKey = `metadata_${serviceUrl}`;
  const cachedData = getFromCache(cacheKey);
  if (cachedData) return cachedData;
  try {
    const response = await axios.get(serviceUrl, { params: { f: 'json' } });
    const metadata = response.data;
    const checks = {
      hasDescription: !!metadata.description,
      hasTags: metadata.tags && metadata.tags.length > 0,
      hasSpatialReference: !!metadata.spatialReference,
    };
    const availability = {
      isAvailable: true,
      responseTime: response.headers['request-duration'] || null,
    };
    let extent = metadata.initialExtent || null;
    if (!extent && serviceUrl.toLowerCase().includes("featureserver")) {
      try {
        const queryResponse = await request(serviceUrl + "/0/query", {
          params: {
            where: "1=1",
            returnExtentOnly: true,
            f: "json",
          },
        });
        if (queryResponse && queryResponse.extent) {
          extent = queryResponse.extent;
        }
      } catch (queryError) {
        console.error(`Error querying extent for ${serviceUrl}: ${queryError.message}`);
      }
    }
    const result = {
      metadata,
      checks,
      availability,
      spatialReference: metadata.spatialReference || 'N/A',
      extent: extent,
    };
    setToCache(cacheKey, result);
    return result;
  } catch (error) {
    console.error(`Error fetching metadata summary for ${serviceUrl}: ${error.message}`);
    return {
      metadata: null,
      checks: null,
      availability: { isAvailable: false, error: error.message },
      spatialReference: 'N/A',
      extent: null,
    };
  }
}

// Fetch layer details (lazy loading).
async function fetchLayerDetails(serviceUrl) {
  const cacheKey = `layerDetails_${serviceUrl}`;
  const cachedData = getFromCache(cacheKey);
  if (cachedData) return cachedData;
  try {
    const response = await request(`${serviceUrl}/layers?f=json`);
    const layers = await Promise.all(
      response.layers.map(async (layer) => {
        return {
          id: layer.id,
          name: layer.name,
          description: layer.description || 'N/A',
          spatialReference: layer.extent?.spatialReference || 'N/A',
          geometryType: layer.geometryType || 'N/A',
          fields: layer.fields || [],
        };
      })
    );
    setToCache(cacheKey, layers);
    return layers;
  } catch (error) {
    console.error(`Error fetching layer details for ${serviceUrl}: ${error.message}`);
    return null;
  }
}

// Fetch sample records (lazy loading).
async function fetchSampleRecords(serviceUrl, layerId) {
  const queryUrl = `${serviceUrl}/${layerId}/query`;
  const cacheKey = `sampleRecords_${queryUrl}`;
  const cachedData = getFromCache(cacheKey);
  if (cachedData) return cachedData;
  try {
    const response = await request(queryUrl, {
      params: {
        where: '1=1',
        outFields: '*',
        resultRecordCount: 5,
        f: 'json',
      },
    });
    const records = response.features ? response.features.map((feature) => feature.attributes) : [];
    setToCache(cacheKey, records);
    return records;
  } catch (error) {
    console.error(`Error fetching sample records for ${queryUrl}: ${error.message}`);
    return null;
  }
}

// Improved keyword extraction.
function improvedExtractKeywords(services) {
  const stopWords = new Set(['service', 'services', 'layer', 'layers', 'data', 'map', 'portal', 'server', 'rest']);
  const keywordCandidates = {};
  const serviceKeywords = new Map();
  services.forEach((service, index) => {
    const text = `${service.name} ${service.description}`.toLowerCase();
    const doc = nlp(text);
    const nounPhrases = doc.nouns().out('array');
    const keywordsForService = new Set();
    nounPhrases.forEach((phrase) => {
      const words = phrase.match(/[a-z]+/g);
      if (!words) return;
      words.forEach(word => {
        if (word.length < 3) return;
        if (stopWords.has(word)) return;
        const singular = nlp(word).nouns().toSingular().out('text') || word;
        keywordsForService.add(singular);
        keywordCandidates[singular] = (keywordCandidates[singular] || 0) + 1;
      });
    });
    serviceKeywords.set(index, keywordsForService);
  });
  const threshold = services.length * 0.8;
  const finalKeywords = new Map();
  services.forEach((service, index) => {
    const keywords = serviceKeywords.get(index);
    keywords.forEach(keyword => {
      if (keywordCandidates[keyword] <= threshold) {
        if (!finalKeywords.has(keyword)) {
          finalKeywords.set(keyword, []);
        }
        finalKeywords.get(keyword).push(service);
      }
    });
  });
  return finalKeywords;
}

// Categorize services.
function categorizeServices(services) {
  const categories = { types: {}, keywords: improvedExtractKeywords(services) };
  services.forEach((service) => {
    const type = service.type;
    if (!categories.types[type]) {
      categories.types[type] = [];
    }
    categories.types[type].push(service);
  });
  return categories;
}

// Endpoint to get basic services.
app.get('/services', async (req, res) => {
  const portalUrl = req.query.portalUrl || DEFAULT_PORTAL_URL;
  console.log(`Fetching services from portal: ${portalUrl}`);
  const data = await fetchServices(portalUrl);
  if (!data || !data.services) {
    return res.status(500).send('<h1>Failed to fetch services from portal.</h1>');
  }
  const services = await Promise.all(
    data.services.map(async (service) => {
      const serviceUrl = `${portalUrl}/${service.name}/${service.type}`;
      const metadataSummary = await fetchMetadataSummary(serviceUrl);
      return {
        name: service.name,
        type: service.type,
        url: serviceUrl,
        description: metadataSummary.metadata ? (metadataSummary.metadata.description || '') : '',
        metadataChecks: metadataSummary.checks,
        availability: metadataSummary.availability,
        spatialReference: metadataSummary.spatialReference,
        extent: metadataSummary.extent
      };
    })
  );
  const categorized = categorizeServices(services);
  
  // Build HTML page with embedded client-side helper functions.
  let html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Indexed Services</title>
    <!-- Include Esri API CSS/JS -->
    <link rel="stylesheet" href="https://js.arcgis.com/4.25/esri/themes/light/main.css">
    <script src="https://js.arcgis.com/4.25/"></script>
    <style>
      body { font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; }
      h1 { color: #333; padding: 10px; }
      form { padding: 10px; }
      input[type="text"] { width: 400px; padding: 5px; }
      button { padding: 5px 10px; }
      select { margin: 10px; padding: 5px; }
      table { width: 100%; border-collapse: collapse; margin: 20px; }
      th, td { border: 1px solid #ccc; padding: 8px; text-align: left; vertical-align: top; }
      th { background-color: #f4f4f4; }
      tr:nth-child(even) { background-color: #f9f9f9; }
      .collapsible { cursor: pointer; text-decoration: underline; color: blue; }
      .content { display: none; margin-top: 10px; padding: 10px; border: 1px solid #ccc; }
      /* Spinner overlay */
      #spinner {
        position: fixed;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(255,255,255,0.8);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 1000;
      }
      .loader {
        border: 16px solid #f3f3f3;
        border-radius: 50%;
        border-top: 16px solid #3498db;
        width: 120px;
        height: 120px;
        animation: spin 2s linear infinite;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      /* Map view container */
      #mapView { display: none; margin: 20px; }
      #mapContainer { width: 100%; height: 500px; }
    </style>
    <script>
      // Client-side helper functions for availability.
      function getAvailabilityColor(responseTime) {
        const rt = parseFloat(responseTime);
        if (isNaN(rt)) return "black";
        if (rt < 500) return "green";
        else if (rt < 1000) return "orange";
        else return "red";
      }
      function getAvailabilityStatus(responseTime) {
        const color = getAvailabilityColor(responseTime);
        if (color === 'green') return 'Good';
        else if (color === 'orange') return 'Warning';
        else if (color === 'red') return 'Problem';
        return 'Available';
      }
      
      // Global variables.
      var portalUrl = "${portalUrl}";
      var servicesData = ${JSON.stringify(services)};
      var map;

      // Hide spinner on window load.
      window.addEventListener('load', function() {
        document.getElementById('spinner').style.display = 'none';
      });
      
      // Toggle between Table and Map views.
      function toggleView() {
        var tableView = document.getElementById('tableView');
        var mapView = document.getElementById('mapView');
        var toggleBtn = document.getElementById('toggleViewBtn');
        if (tableView.style.display === 'none') {
          tableView.style.display = 'block';
          mapView.style.display = 'none';
          toggleBtn.innerText = 'Map View';
        } else {
          tableView.style.display = 'none';
          mapView.style.display = 'block';
          toggleBtn.innerText = 'Table View';
          var filteredServices = getFilteredServices();
          initMap(filteredServices);
        }
      }
      
      // Return filtered services.
      function getFilteredServices() {
        var typeFilter = document.getElementById('type-filter').value;
        var keywordFilter = document.getElementById('keyword-filter').value;
        return servicesData.filter(function(service) {
          var text = (service.name + ' ' + service.description).toLowerCase();
          var typeMatches = typeFilter === 'all' || service.type === typeFilter;
          var keywordMatches = keywordFilter === 'all' || text.includes(keywordFilter);
          return typeMatches && keywordMatches;
        });
      }
      
      // Initialize the Esri map.
      function initMap(filteredServices) {
        require([
          "esri/Map",
          "esri/views/MapView",
          "esri/layers/FeatureLayer",
          "esri/layers/MapImageLayer",
          "esri/Graphic"
        ], function(Map, MapView, FeatureLayer, MapImageLayer, Graphic) {
          if (map) { map.destroy(); }
          map = new Map({ basemap: "streets" });
          var view = new MapView({
            container: "mapContainer",
            map: map,
            center: [0, 0],
            zoom: 2
          });
          
          var serviceLayers = [];
          var fallbackMarkers = [];
          var unionExtent = null;
          var servicesToPlot = filteredServices || servicesData;
          
          servicesToPlot.forEach(function(service) {
            if (service.extent && service.extent.xmin !== undefined) {
              if (!unionExtent) {
                unionExtent = {
                  xmin: service.extent.xmin,
                  ymin: service.extent.ymin,
                  xmax: service.extent.xmax,
                  ymax: service.extent.ymax
                };
              } else {
                unionExtent.xmin = Math.min(unionExtent.xmin, service.extent.xmin);
                unionExtent.ymin = Math.min(unionExtent.ymin, service.extent.ymin);
                unionExtent.xmax = Math.max(unionExtent.xmax, service.extent.xmax);
                unionExtent.ymax = Math.max(unionExtent.ymax, service.extent.ymax);
              }
            }
            
            // Use RegExp constructor to correctly match service URLs.
            if (new RegExp("featureserver(\\/\\d+)?$", "i").test(service.url)) {
              var fl = new FeatureLayer({
                url: service.url,
                outFields: ["*"],
                popupTemplate: {
                  title: service.name,
                  content: "Status: <span style='color: " + getAvailabilityColor(service.availability.responseTime) + ";'>" + getAvailabilityStatus(service.availability.responseTime) + " (" + (service.availability.responseTime || 'N/A') + " ms)</span><br><a href='" + service.url + "' target='_blank'>Open Service</a>"
                }
              });
              serviceLayers.push(fl);
            } else if (new RegExp("mapserver(\\/\\d+)?$", "i").test(service.url)) {
              var mil = new MapImageLayer({
                url: service.url,
                popupTemplate: {
                  title: service.name,
                  content: "Status: <span style='color: " + getAvailabilityColor(service.availability.responseTime) + ";'>" + getAvailabilityStatus(service.availability.responseTime) + " (" + (service.availability.responseTime || 'N/A') + " ms)</span><br><a href='" + service.url + "' target='_blank'>Open Service</a>"
                }
              });
              serviceLayers.push(mil);
            } else if (service.extent && service.extent.xmin !== undefined) {
              var centerX = (service.extent.xmin + service.extent.xmax) / 2;
              var centerY = (service.extent.ymin + service.extent.ymax) / 2;
              var point = {
                type: "point",
                longitude: centerX,
                latitude: centerY
              };
              var symbol = {
                type: "simple-marker",
                color: "red",
                outline: { color: "white", width: 1 }
              };
              var graphic = new Graphic({
                geometry: point,
                symbol: symbol,
                attributes: { name: service.name, url: service.url },
                popupTemplate: {
                  title: service.name,
                  content: "Status: <span style='color: " + getAvailabilityColor(service.availability.responseTime) + ";'>" + getAvailabilityStatus(service.availability.responseTime) + " (" + (service.availability.responseTime || 'N/A') + " ms)</span><br><a href='" + service.url + "' target='_blank'>Open Service</a>"
                }
              });
              fallbackMarkers.push(graphic);
            }
          });
          
          serviceLayers.forEach(function(layer) {
            map.add(layer);
          });
          view.graphics.addMany(fallbackMarkers);
          if (unionExtent) {
            view.goTo(unionExtent, { maxZoom: 10 });
          }
        });
      }
      
      // Filter table view and update map view if active.
      function filterServices() {
        var typeFilter = document.getElementById('type-filter').value;
        var keywordFilter = document.getElementById('keyword-filter').value;
        var rows = document.querySelectorAll('.service-row');
        rows.forEach(function(row) {
          var matchesType = typeFilter === 'all' || row.dataset.type === typeFilter;
          var matchesKeyword = keywordFilter === 'all' || row.dataset.keyword.includes(keywordFilter);
          row.style.display = matchesType && matchesKeyword ? '' : 'none';
        });
        var mapView = document.getElementById('mapView');
        if (mapView.style.display !== 'none') {
          var filteredServices = getFilteredServices();
          initMap(filteredServices);
        }
      }
      
      async function toggleLayerDetails(serviceName, serviceType, rowId, btn) {
        var container = document.getElementById(rowId);
        if (container.style.display === 'block') {
          container.style.display = 'none';
          btn.innerText = 'View Layers';
        } else {
          if (container.innerHTML.trim() === '') {
            const response = await fetch(\`/services/\${encodeURIComponent(serviceName)}/\${encodeURIComponent(serviceType)}/layers?portalUrl=\${encodeURIComponent(portalUrl)}\`);
            const layers = await response.json();
            let html = '';
            layers.forEach(function(layer) {
              html += '<div><strong>Layer:</strong> ' + layer.name +
                      ' (<a href="#" onclick="toggleSampleRecords(\\'' + serviceName + '\\', \\'' + serviceType + '\\', ' + layer.id + ', this); return false;">View Sample Records</a>)' +
                      '<div class="sample-records" style="display:none;"></div>' +
                      '<br><strong>Description:</strong> ' + layer.description +
                      '<br><strong>Geometry:</strong> ' + layer.geometryType +
                      '<br><strong>Spatial Reference:</strong> ' + (layer.spatialReference.wkid || "N/A") +
                      '<br><strong>Fields:</strong> ' + (layer.fields ? layer.fields.map(function(f) { return f.name; }).join(', ') : "N/A") +
                      '</div><hr>';
            });
            container.innerHTML = html;
          }
          container.style.display = 'block';
          btn.innerText = 'Close Layers';
        }
      }
      
      async function toggleSampleRecords(serviceName, serviceType, layerId, linkElement) {
        var recordDiv = linkElement.parentNode.querySelector('.sample-records');
        if (!recordDiv) {
          recordDiv = document.createElement('div');
          recordDiv.className = 'sample-records';
          linkElement.parentNode.appendChild(recordDiv);
        }
        if (recordDiv.style.display === 'block') {
          recordDiv.style.display = 'none';
          linkElement.innerText = 'View Sample Records';
        } else {
          if (recordDiv.innerHTML.trim() === '') {
            const response = await fetch(\`/services/\${encodeURIComponent(serviceName)}/\${encodeURIComponent(serviceType)}/layers/\${layerId}/records?portalUrl=\${encodeURIComponent(portalUrl)}\`);
            const records = await response.json();
            let html = '<table><thead><tr>';
            if (records.length > 0) {
              Object.keys(records[0]).forEach(function(field) {
                html += '<th>' + field + '</th>';
              });
              html += '</tr></thead><tbody>';
              records.forEach(function(record) {
                html += '<tr>' + Object.values(record).map(function(value) {
                  return '<td>' + value + '</td>';
                }).join('') + '</tr>';
              });
              html += '</tbody></table>';
            } else {
              html = 'No sample records available.';
            }
            recordDiv.innerHTML = html;
          }
          recordDiv.style.display = 'block';
          linkElement.innerText = 'Hide Sample Records';
        }
      }
    </script>
  </head>
  <body>
    <!-- Spinner overlay -->
    <div id="spinner">
      <div class="loader"></div>
    </div>
    <h1>Indexed Services</h1>
    <!-- Form for portal URL -->
    <form method="GET" action="/services">
      <label for="portalUrl">Portal URL:</label>
      <input type="text" id="portalUrl" name="portalUrl" value="${portalUrl}">
      <button type="submit">Load Services</button>
    </form>
    <!-- Toggle view button -->
    <button id="toggleViewBtn" onclick="toggleView()">Map View</button>
    <label for="type-filter">Filter by Type:</label>
    <select id="type-filter" onchange="filterServices()">
      <option value="all">All</option>`;
  
  Object.keys(categorized.types).forEach(function(type) {
    html += `<option value="${type}">${type}</option>`;
  });
  
  html += `</select>
    <label for="keyword-filter">Filter by Keyword:</label>
    <select id="keyword-filter" onchange="filterServices()">
      <option value="all">All</option>`;
  
  Array.from(categorized.keywords.keys()).forEach(function(keyword) {
    html += `<option value="${keyword}">${keyword}</option>`;
  });
  
  html += `</select>
    <!-- Table view container -->
    <div id="tableView">
      <table>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>URL</th>
          <th>Availability</th>
          <th>Coordinate System</th>
          <th>Actions</th>
        </tr>`;
  
  services.forEach(function(service, index) {
    const serviceText = (service.name + ' ' + service.description).toLowerCase();
    const keywords = Array.from(categorized.keywords.keys()).filter(function(keyword) {
      return serviceText.includes(keyword);
    }).join(',');
    html += `
        <tr class="service-row" data-type="${service.type}" data-keyword="${keywords}">
          <td>${service.name}</td>
          <td>${service.type}</td>
          <td><a href="${service.url}" target="_blank">${service.url}</a></td>
          <td>${service.availability.isAvailable ? `<span style="color: ${getAvailabilityColor(service.availability.responseTime)};">${getAvailabilityStatus(service.availability.responseTime)} (${service.availability.responseTime || 'N/A'} ms)</span>` : 'Unavailable'}</td>
          <td>${service.spatialReference.wkid || service.spatialReference.latestWkid || 'N/A'}</td>
          <td>
            <button onclick="toggleLayerDetails('${service.name}', '${service.type}', 'details-${index}', this)">View Layers</button>
            <div id="details-${index}" class="content"></div>
          </td>
        </tr>`;
  });
  
  html += `</table>
    </div>
    <!-- Map view container -->
    <div id="mapView">
      <div id="mapContainer"></div>
    </div>
  </body>
  </html>`;
  
  res.send(html);
});

// Endpoint for layer details.
app.get('/services/:serviceName/:serviceType/layers', async (req, res) => {
  const portalUrl = req.query.portalUrl || DEFAULT_PORTAL_URL;
  const { serviceName, serviceType } = req.params;
  const serviceUrl = `${portalUrl}/${serviceName}/${serviceType}`;
  const layers = await fetchLayerDetails(serviceUrl);
  res.json(layers || []);
});

// Endpoint for sample records.
app.get('/services/:serviceName/:serviceType/layers/:layerId/records', async (req, res) => {
  const portalUrl = req.query.portalUrl || DEFAULT_PORTAL_URL;
  const { serviceName, serviceType, layerId } = req.params;
  const serviceUrl = `${portalUrl}/${serviceName}/${serviceType}`;
  const records = await fetchSampleRecords(serviceUrl, layerId);
  res.json(records || []);
});

// Health check endpoint.
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Start the server.
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Access the service endpoint at http://localhost:${PORT}/services`);
});
