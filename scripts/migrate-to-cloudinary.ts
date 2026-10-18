import { prisma } from '../src/config/prisma';
import { uploadToCloudinary } from '../src/utils/cloudinary';

async function main() {
  console.log('--- Migrating Base64 Images to Cloudinary CDN ---');

  const categories = await prisma.serviceCategory.findMany({
    where: {
      icon: {
        startsWith: 'data:',
      },
    },
  });

  console.log(`Found ${categories.length} category records with Base64 icons.`);
  for (const cat of categories) {
    if (cat.icon) {
      console.log(`Uploading icon for category: "${cat.name}"...`);
      try {
        const cdnUrl = await uploadToCloudinary(cat.icon, 'servfex/categories');
        await prisma.serviceCategory.update({
          where: { id: cat.id },
          data: { icon: cdnUrl },
        });
        console.log(`✓ Updated category "${cat.name}" with Cloudinary URL: ${cdnUrl}`);
      } catch (err) {
        console.error(`✗ Failed for category "${cat.name}":`, err);
      }
    }
  }

  const services = await prisma.service.findMany({
    where: {
      imageUrl: {
        startsWith: 'data:',
      },
    },
  });

  console.log(`Found ${services.length} service records with Base64 images.`);
  for (const s of services) {
    if (s.imageUrl) {
      console.log(`Uploading image for service: "${s.name}"...`);
      try {
        const cdnUrl = await uploadToCloudinary(s.imageUrl, 'servfex/services');
        await prisma.service.update({
          where: { id: s.id },
          data: { imageUrl: cdnUrl },
        });
        console.log(`✓ Updated service "${s.name}" with Cloudinary URL: ${cdnUrl}`);
      } catch (err) {
        console.error(`✗ Failed for service "${s.name}":`, err);
      }
    }
  }

  console.log('--- Migration completed successfully! ---');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
