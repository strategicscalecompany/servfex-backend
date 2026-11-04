const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function test() {
  const loc = 'latitude=17.433878&longitude=78.406987';
  const catRes = await get(`https://api.servfex.com/api/v1/catalog/categories?${loc}`);
  const srvRes = await get(`https://api.servfex.com/api/v1/catalog/services?limit=100&${loc}`);

  const categories = catRes.data?.categories || catRes.categories || [];
  const allServices = srvRes.data?.services || srvRes.services || [];

  console.log(`Loaded ${categories.length} categories, ${allServices.length} allServices`);

  for (const cat of categories) {
    console.log(`\n========================================`);
    console.log(`Category: ${cat.name} (${cat.id})`);
    for (const sub of (cat.subCategories || [])) {
      console.log(`\n  SubCategory: ${sub.name} (${sub.id})`);
      console.log(`  SubCategory.services tiles count: ${sub.services?.length || 0}`);
      const tileIds = new Set((sub.services || []).map(s => s.id));
      console.log(`  Tile IDs in sub:`, [...tileIds]);

      // Filter matching services as CategoryExploreScreen does:
      const subId = sub.id;
      const matchingServices = allServices.filter(svc => {
        return svc.subCategoryId === subId || tileIds.has(svc.id);
      });

      console.log(`  matchingServices count: ${matchingServices.length}`);
      for (const ms of matchingServices) {
        console.log(`    Matching Service: "${ms.name}" (${ms.id}) subCategoryId: "${ms.subCategoryId}"`);
        console.log(`    Packages (${ms.packages?.length || 0}):`, (ms.packages || []).map(p => `"${p.title || p.name}" (${p.id})`).join(', '));
      }
    }
  }
}

test().catch(console.error);
