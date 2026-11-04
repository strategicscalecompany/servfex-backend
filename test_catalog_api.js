const https = require('https');

https.get('https://api.servfex.com/api/v1/catalog/categories?latitude=17.433878&longitude=78.406987', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      const categories = json.data?.categories || json.categories || [];
      const painting = categories.find(c => c.name.includes('Painting'));
      if (painting) {
        console.log(JSON.stringify(painting.subCategories, null, 2));
      }
    } catch (e) {
      console.error(e);
    }
  });
});
