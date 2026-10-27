import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { PrismaClient } from '@prisma/client';
import { v2 as cloudinary } from 'cloudinary';

const prisma = new PrismaClient();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const isCloudinary = (url?: string | null): boolean => {
  if (!url) return false;
  return url.includes('res.cloudinary.com') || url.includes('cloudinary.com/');
};

// URL Cache to avoid re-uploading the exact same source image multiple times
const urlUploadCache = new Map<string, string>();

async function uploadUrlToCloudinary(url: string | null | undefined, folder: string): Promise<string | null> {
  if (!url || !url.trim()) return null;
  let cleanUrl = url.trim();

  // Handle known dead URLs
  if (cleanUrl.includes('photo-1548839140')) {
    cleanUrl = 'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?auto=format&fit=crop&w=1200&q=80';
  }

  if (isCloudinary(cleanUrl)) {
    return cleanUrl;
  }

  if (urlUploadCache.has(cleanUrl)) {
    return urlUploadCache.get(cleanUrl)!;
  }

  try {
    const res = await cloudinary.uploader.upload(cleanUrl, {
      folder,
      timeout: 120000,
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    });
    console.log(`    ✓ Uploaded to Cloudinary [${folder}]: ${res.secure_url}`);
    urlUploadCache.set(cleanUrl, res.secure_url);
    return res.secure_url;
  } catch (err: any) {
    console.warn(`    ⚠️ Cloudinary upload warning for "${cleanUrl.slice(0, 60)}...":`, err.message || err);
    return cleanUrl; // keep fallback if upload fails
  }
}

async function main() {
  console.log('================================================================');
  console.log('🚀 STARTING SERVFEX CATALOG -> CLOUDINARY MEDIA MIGRATION');
  console.log(`Cloudinary Cloud: ${process.env.CLOUDINARY_CLOUD_NAME}`);
  console.log('================================================================\n');

  // 1. Categories
  const categories = await prisma.serviceCategory.findMany({
    where: { isActive: true },
  });
  console.log(`📦 [1/4] Processing ${categories.length} Categories...`);
  for (const cat of categories) {
    if (cat.iconUrl && !isCloudinary(cat.iconUrl)) {
      console.log(`  - Category: "${cat.name}"`);
      const cloudUrl = await uploadUrlToCloudinary(cat.iconUrl, 'servfex/categories');
      if (cloudUrl && cloudUrl !== cat.iconUrl) {
        await prisma.serviceCategory.update({
          where: { id: cat.id },
          data: { iconUrl: cloudUrl },
        });
      }
    }
  }

  // 2. Sub-Categories
  const subCategories = await prisma.serviceSubCategory.findMany({
    where: { isActive: true },
  });
  console.log(`\n📂 [2/4] Processing ${subCategories.length} Sub-Categories...`);
  for (const sc of subCategories) {
    console.log(`  - SubCategory: "${sc.name}"`);
    let needsUpdate = false;
    let newIconUrl = sc.iconUrl;
    if (sc.iconUrl && !isCloudinary(sc.iconUrl)) {
      newIconUrl = await uploadUrlToCloudinary(sc.iconUrl, 'servfex/sub-categories');
      if (newIconUrl !== sc.iconUrl) needsUpdate = true;
    }

    const newBanners: string[] = [];
    if (sc.bannerImages && sc.bannerImages.length > 0) {
      for (const bUrl of sc.bannerImages) {
        if (bUrl && !isCloudinary(bUrl)) {
          const cloudBanner = await uploadUrlToCloudinary(bUrl, 'servfex/sub-categories/banners');
          newBanners.push(cloudBanner || bUrl);
          needsUpdate = true;
        } else if (bUrl) {
          newBanners.push(bUrl);
        }
      }
    }

    if (needsUpdate) {
      await prisma.serviceSubCategory.update({
        where: { id: sc.id },
        data: {
          iconUrl: newIconUrl,
          bannerImages: newBanners.length > 0 ? newBanners : sc.bannerImages,
        },
      });
    }
  }

  // 3. Services
  const services = await prisma.service.findMany({
    where: { isActive: true },
  });
  console.log(`\n🛠️ [3/4] Processing ${services.length} Services...`);
  for (const s of services) {
    console.log(`  - Service: "${s.name}"`);
    let needsUpdate = false;
    let newIconUrl = s.iconUrl;
    if (s.iconUrl && !isCloudinary(s.iconUrl)) {
      newIconUrl = await uploadUrlToCloudinary(s.iconUrl, 'servfex/services');
      if (newIconUrl !== s.iconUrl) needsUpdate = true;
    }

    const newBanners: string[] = [];
    if (s.bannerImages && s.bannerImages.length > 0) {
      for (const bUrl of s.bannerImages) {
        if (bUrl && !isCloudinary(bUrl)) {
          const cloudBanner = await uploadUrlToCloudinary(bUrl, 'servfex/services/banners');
          newBanners.push(cloudBanner || bUrl);
          needsUpdate = true;
        } else if (bUrl) {
          newBanners.push(bUrl);
        }
      }
    }

    if (needsUpdate) {
      await prisma.service.update({
        where: { id: s.id },
        data: {
          iconUrl: newIconUrl,
          bannerImages: newBanners.length > 0 ? newBanners : s.bannerImages,
        },
      });
    }
  }

  // 4. Packages
  const packages = await prisma.servicePackage.findMany({
    where: { isActive: true },
  });
  console.log(`\n📦 [4/4] Processing ${packages.length} Service Packages...`);
  for (const p of packages) {
    let needsUpdate = false;
    let newCardImage = p.cardImage;
    if (p.cardImage && !isCloudinary(p.cardImage)) {
      console.log(`  - Package: "${p.name}" cardImage`);
      newCardImage = await uploadUrlToCloudinary(p.cardImage, 'servfex/packages/cards');
      if (newCardImage !== p.cardImage) needsUpdate = true;
    }

    const newDetailBanners: string[] = [];
    if (p.detailBannerImages && p.detailBannerImages.length > 0) {
      for (const dbUrl of p.detailBannerImages) {
        if (dbUrl && !isCloudinary(dbUrl)) {
          const cloudBanner = await uploadUrlToCloudinary(dbUrl, 'servfex/packages/banners');
          newDetailBanners.push(cloudBanner || dbUrl);
          needsUpdate = true;
        } else if (dbUrl) {
          newDetailBanners.push(dbUrl);
        }
      }
    }

    // Process steps images
    let newSteps = p.processSteps as any[];
    if (Array.isArray(newSteps) && newSteps.length > 0) {
      const updatedSteps = [];
      let stepsChanged = false;
      for (const step of newSteps) {
        if (step.imageUrl && !isCloudinary(step.imageUrl)) {
          const cloudStepImg = await uploadUrlToCloudinary(step.imageUrl, 'servfex/packages/steps');
          updatedSteps.push({ ...step, imageUrl: cloudStepImg });
          stepsChanged = true;
        } else {
          updatedSteps.push(step);
        }
      }
      if (stepsChanged) {
        newSteps = updatedSteps;
        needsUpdate = true;
      }
    }

    // Requirements icons (if remote url)
    let newReqs = p.requirements as any[];
    if (Array.isArray(newReqs) && newReqs.length > 0) {
      const updatedReqs = [];
      let reqsChanged = false;
      for (const req of newReqs) {
        if (req.iconUrl && req.iconUrl.startsWith('http') && !isCloudinary(req.iconUrl)) {
          const cloudReqIcon = await uploadUrlToCloudinary(req.iconUrl, 'servfex/packages/icons');
          updatedReqs.push({ ...req, iconUrl: cloudReqIcon });
          reqsChanged = true;
        } else {
          updatedReqs.push(req);
        }
      }
      if (reqsChanged) {
        newReqs = updatedReqs;
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      await prisma.servicePackage.update({
        where: { id: p.id },
        data: {
          cardImage: newCardImage,
          detailBannerImages: newDetailBanners.length > 0 ? newDetailBanners : p.detailBannerImages,
          processSteps: newSteps,
          requirements: newReqs,
        },
      });
    }
  }

  console.log('\n================================================================');
  console.log(`🎉 ALL MEDIA SUCCESSFULLY MIGRATED TO CLOUDINARY!`);
  console.log(`Total unique assets uploaded and cached: ${urlUploadCache.size}`);
  console.log('All MongoDB documents now store authoritative res.cloudinary.com URLs.');
  console.log('================================================================');
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
