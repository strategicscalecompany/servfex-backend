import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// High resolution, fast Unsplash CDN photography matching Urban Company aesthetics
const ASSETS = {
  cleaning: {
    catIcon: 'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=400&q=80',
    bathroom: {
      icon: 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1584820927498-cfe5211fd8bf?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?auto=format&fit=crop&w=600&q=80',
      ],
    },
    kitchen: {
      icon: 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1588854337221-4cf9fa96059c?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1507089947368-19c1da9775ae?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1584820927498-cfe5211fd8bf?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1588854337221-4cf9fa96059c?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1584820927498-cfe5211fd8bf?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1507089947368-19c1da9775ae?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=600&q=80',
      ],
    },
    fullHome: {
      icon: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1584820927498-cfe5211fd8bf?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=600&q=80',
      ],
    },
    sofa: {
      icon: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1540574163026-643ea20ade25?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=600&q=80',
      ],
    },
    pest: {
      icon: 'https://images.unsplash.com/photo-1584820927498-cfe5211fd8bf?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1584820927498-cfe5211fd8bf?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1584820927498-cfe5211fd8bf?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=600&q=80',
      ],
    },
  },
  acAppliance: {
    catIcon: 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=400&q=80',
    ac: {
      icon: 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=1200&q=80',
        'https://images.unsplash.com/photo-1581092160607-ee22621dd758?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1581092160607-ee22621dd758?auto=format&fit=crop&w=600&q=80',
      ],
    },
    washing: {
      icon: 'https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?auto=format&fit=crop&w=600&q=80',
      ],
    },
    ro: {
      icon: 'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?auto=format&fit=crop&w=600&q=80',
      ],
    },
  },
  homeRepairs: {
    catIcon: 'https://images.unsplash.com/photo-1581244277943-fe4a9c777189?auto=format&fit=crop&w=400&q=80',
    electric: {
      icon: 'https://images.unsplash.com/photo-1621905252507-b35492cc74b4?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1621905252507-b35492cc74b4?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1621905252507-b35492cc74b4?auto=format&fit=crop&w=600&q=80',
      ],
    },
    plumbing: {
      icon: 'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?auto=format&fit=crop&w=600&q=80',
      ],
    },
    carpentry: {
      icon: 'https://images.unsplash.com/photo-1533090161767-e6ffed986c88?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1533090161767-e6ffed986c88?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1533090161767-e6ffed986c88?auto=format&fit=crop&w=600&q=80',
      ],
    },
  },
  womenSalon: {
    catIcon: 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=400&q=80',
    waxing: {
      icon: 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=600&q=80',
      ],
    },
    facial: {
      icon: 'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?auto=format&fit=crop&w=400&q=80',
      banners: [
        'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?auto=format&fit=crop&w=1200&q=80',
      ],
      steps: [
        'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?auto=format&fit=crop&w=600&q=80',
      ],
    },
  },
};

async function main() {
  console.log('================================================================');
  console.log('--- PURGING TEST DATA & SEEDING COMPLETE URBAN COMPANY CATALOG ---');
  console.log('================================================================');

  // 1. DELETE USER TEST CATEGORY (4e57dc0f-fb45-4bb3-9358-2366be92d5bb with person picture)
  // AND REMOVE STALE / BROKEN TEST CATEGORIES
  const testCategoryIds = [
    '4e57dc0f-fb45-4bb3-9358-2366be92d5bb', // User's test "cleaning" category with person photo
    'ee7defb0-0630-4eda-b5e3-ce093ba332ed', // Sofa Cleaning Service
    'e4429001-9e5d-4f73-a397-4c960eeb0bf9', // Sofa Cleaning Service
    'c2aaad1d-bfd5-4340-95ec-00b8e3994ee4', // Sofa Cleaning Service
    '97249e12-e408-493b-a10c-29c871d7776d', // Pest Control
    '86295cf8-1a4a-414e-ae14-641ca2575008', // Intermediate seed category
  ];

  for (const catId of testCategoryIds) {
    try {
      // Find sub-categories and delete their packages and services
      const subCats = await prisma.serviceSubCategory.findMany({ where: { categoryId: catId } });
      for (const sc of subCats) {
        const services = await prisma.service.findMany({ where: { subCategoryId: sc.id } });
        for (const s of services) {
          await prisma.servicePackage.deleteMany({ where: { serviceId: s.id } });
          await prisma.service.delete({ where: { id: s.id } }).catch(() => {});
        }
        await prisma.serviceSubCategory.delete({ where: { id: sc.id } }).catch(() => {});
      }
      // Delete any direct services
      const directServices = await prisma.service.findMany({ where: { categoryId: catId } });
      for (const s of directServices) {
        await prisma.servicePackage.deleteMany({ where: { serviceId: s.id } });
        await prisma.service.delete({ where: { id: s.id } }).catch(() => {});
      }
      await prisma.serviceCategory.delete({ where: { id: catId } }).catch(() => {});
      console.log(`✓ Deleted test category and all children: ${catId}`);
    } catch (e) {
      // Ignore not found
    }
  }

  // 2. DEFINE THE MASTER URBAN COMPANY CATALOG
  const UC_CATALOG = [
    // ──────── CATEGORY 1: CLEANING & PEST CONTROL ────────
    {
      name: 'Cleaning & Pest Control',
      slug: 'cleaning-pest-control',
      iconUrl: ASSETS.cleaning.catIcon,
      description: 'Professional home, kitchen, bathroom, sofa cleaning & certified pest control',
      displayOrder: 1,
      subCategories: [
        {
          name: 'Bathroom & Toilet Cleaning',
          iconUrl: ASSETS.cleaning.bathroom.icon,
          bannerImages: ASSETS.cleaning.bathroom.banners,
          packages: [
            {
              name: 'Classic Bathroom Cleaning',
              sectionTitle: 'Intense Cleaning',
              badgeText: 'MOST POPULAR',
              shortDescription: 'Deep stain removal, tile descaling, commode sanitization & mirror polishing',
              originalPrice: '699.00',
              discountedPrice: '499.00',
              savingsLabel: 'Save ₹200 (29% off)',
              duration: '60 mins',
              pricePerUnitLabel: 'per bathroom',
              cardImage: ASSETS.cleaning.bathroom.banners[0],
              detailBannerImages: ASSETS.cleaning.bathroom.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                'Deep stain removal from hard water deposits & yellow scaling',
                'Hospital-grade sanitization of commode, sink & taps',
                'Tile scrubbing with mechanized rotary brush',
                'Mirror & glass shine with streak-free formula',
              ],
              processTitle: 'Our 4-Step Cleaning Process',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Pre-treatment & Descaling',
                  description: 'Eco-friendly descaling solution sprayed on tiles, commode, and chrome fittings.',
                  imageUrl: ASSETS.cleaning.bathroom.steps[0],
                },
                {
                  stepNumber: 2,
                  title: 'Mechanized Tile Scrubbing',
                  description: 'Rotary brush scrubber cleans tile grout, removing grime and hard water marks.',
                  imageUrl: ASSETS.cleaning.bathroom.steps[1],
                },
                {
                  stepNumber: 3,
                  title: 'Fixtures & Chrome Buffing',
                  description: 'Taps, shower head, and mirror buffed to a mirror finish.',
                  imageUrl: ASSETS.cleaning.bathroom.steps[2],
                },
                {
                  stepNumber: 4,
                  title: 'Floor Drying & Sanitization',
                  description: 'Complete water vacuuming, floor drying, and aromatic deodorization.',
                  imageUrl: ASSETS.cleaning.bathroom.steps[3],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: [
                'Toilet bowl interior & exterior scrubbing',
                'Tile walls scrubbed up to 7 feet',
                'Washbasin, taps, mirror & vanity cleaning',
                'Exhaust fan, geyser exterior & door wiped',
                'Floor cleaning & mechanized drying',
              ],
              requirementsTitle: 'What We Need From You',
              requirements: [
                { iconUrl: '', label: 'Running hot/cold water supply' },
                { iconUrl: '', label: 'Electrical socket for rotary scrubber' },
                { iconUrl: '', label: 'Removal of personal toiletries before start' },
              ],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: [
                'Hard water stains older than 6 months may fade by 70-80% but may not completely disappear.',
              ],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [
                { question: 'How long does the service take?', answer: 'A single standard bathroom takes approximately 60 to 75 minutes.' },
                { question: 'Are the chemicals safe for kids and pets?', answer: 'Yes, we use government-approved, non-hazardous, eco-friendly cleaning agents.' },
              ],
            },
            {
              name: 'Move-in / Move-out Bathroom Deep Clean',
              sectionTitle: 'Intense Cleaning',
              badgeText: 'DEEP RESTORE',
              shortDescription: 'Heavy-duty acid-free restoration for newly shifted or long uncleaned bathrooms',
              originalPrice: '1099.00',
              discountedPrice: '799.00',
              savingsLabel: 'Save ₹300 (27% off)',
              duration: '90 mins',
              pricePerUnitLabel: 'per bathroom',
              cardImage: ASSETS.cleaning.bathroom.banners[1],
              detailBannerImages: ASSETS.cleaning.bathroom.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                'Double-pass mechanized tile scrubbing with heavy-duty descaler',
                'Drain cleaning and foul odor neutralizer application',
                'Full ceiling cobweb removal and ventilation duct cleaning',
              ],
              processTitle: 'Restoration Workflow',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Heavy Scale Soak',
                  description: 'Industrial-grade safe acidic gel breaks down years of mineral build-up and soap scum.',
                  imageUrl: ASSETS.cleaning.bathroom.steps[0],
                },
                {
                  stepNumber: 2,
                  title: 'Double Rotary Scrub',
                  description: 'Floor and walls undergo dual-pass machine scrubbing for maximum grit removal.',
                  imageUrl: ASSETS.cleaning.bathroom.steps[1],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: [
                'All tiles scrubbed to ceiling height',
                'Deep commode and flush tank exterior detailing',
                'Drain trap clearing and anti-odor flush',
              ],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Uninterrupted power & water' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['Broken tiles or corroded chrome plating cannot be mechanically repaired.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'Will this remove severe yellow water stains?', answer: 'Yes, our restoration formula removes up to 90% of persistent mineral deposits.' }],
            },
          ],
        },
        {
          name: 'Kitchen Deep Cleaning',
          iconUrl: ASSETS.cleaning.kitchen.icon,
          bannerImages: ASSETS.cleaning.kitchen.banners,
          packages: [
            {
              name: 'Complete Kitchen Deep Clean',
              sectionTitle: 'Complete Kitchen Cleaning',
              badgeText: 'BESTSELLER',
              shortDescription: 'Intensive oil, grease, carbon & grime removal from tiles, cabinets, stove, and sink',
              originalPrice: '1899.00',
              discountedPrice: '1399.00',
              savingsLabel: 'Save ₹500 (26% off)',
              duration: '120 mins',
              pricePerUnitLabel: 'per kitchen',
              cardImage: ASSETS.cleaning.kitchen.banners[0],
              detailBannerImages: ASSETS.cleaning.kitchen.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                'Complete degreasing of gas stove burners, dials, and stainless steel counter',
                'Tile backsplash oil & carbon stain removal',
                'Cabinet exterior detailing and handle sanitization',
                'Sink descaling and drain pipe unclogging flush',
              ],
              processTitle: 'Our 4-Step Degreasing Process',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Chemical Degreaser Soak',
                  description: 'Food-grade alkaline foam is sprayed across the stove, backsplash tiles, and exhaust.',
                  imageUrl: ASSETS.cleaning.kitchen.steps[0],
                },
                {
                  stepNumber: 2,
                  title: 'Abrasive-Free Scrubbing',
                  description: 'Special non-scratch nylon pads lift burnt carbon and sticky oil without dulling surfaces.',
                  imageUrl: ASSETS.cleaning.kitchen.steps[1],
                },
                {
                  stepNumber: 3,
                  title: 'Cabinet & Appliance Detailing',
                  description: 'All modular cabinet doors, microwave exterior, and fridge exterior are wiped spotless.',
                  imageUrl: ASSETS.cleaning.kitchen.steps[2],
                },
                {
                  stepNumber: 4,
                  title: 'Sanitization & Counter Buffing',
                  description: 'Counters are disinfected and machine-buffed to a clean hygienic shine.',
                  imageUrl: ASSETS.cleaning.kitchen.steps[3],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: [
                'Gas stove, knobs, burner rings & drip trays',
                'Wall tiles degreased up to ceiling level',
                'Cabinet exterior wipe & stain removal',
                'Kitchen sink, tap & water purifier exterior',
              ],
              requirementsTitle: 'What We Need From You',
              requirements: [
                { iconUrl: '', label: 'Removal of open spices and utensils from countertops' },
                { iconUrl: '', label: 'Active water and electricity connection' },
              ],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['Cleaning of internal cabinet contents is only done if cabinets are emptied prior to arrival.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'Do I need to empty all cabinets?', answer: 'For standard service, we clean all cabinet exteriors. If you want inner shelves cleaned, please empty them before arrival.' }],
            },
            {
              name: 'Chimney & Gas Stove Degreasing',
              sectionTitle: 'Appliance Degreasing',
              badgeText: 'EXPRESS',
              shortDescription: 'Dedicated heavy-duty chemical degreasing for sticky chimney filters, hoods, and stove',
              originalPrice: '799.00',
              discountedPrice: '549.00',
              savingsLabel: 'Save ₹250 (31% off)',
              duration: '60 mins',
              pricePerUnitLabel: 'per appliance',
              cardImage: ASSETS.cleaning.kitchen.banners[1],
              detailBannerImages: ASSETS.cleaning.kitchen.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                'Baffle / mesh filter boiling water degreasing bath',
                'Outer hood grease film removal and stainless steel polish',
                'Gas burner unclogging for blue flame efficiency',
              ],
              processTitle: 'Degreasing Steps',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Filter Dismantling',
                  description: 'Filters are submerged in an industrial solvent bath to dissolve coagulated grease.',
                  imageUrl: ASSETS.cleaning.kitchen.steps[0],
                },
                {
                  stepNumber: 2,
                  title: 'Hood & Tray Detailing',
                  description: 'Oil collector tray is drained, disinfected, and re-fitted cleanly.',
                  imageUrl: ASSETS.cleaning.kitchen.steps[1],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: ['Chimney filters chemical soak and rinse', 'Chimney exterior hood wipe down', 'Gas stove cooktop, burners & control dials'],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Hot water availability for filter bath' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['Duct pipe replacement or electronic PCB repair is not included.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'How often should chimney filters be degreased?', answer: 'For regular cooking, chimney filters should be professionally cleaned every 2 to 3 months.' }],
            },
          ],
        },
        {
          name: 'Full Home Deep Cleaning',
          iconUrl: ASSETS.cleaning.fullHome.icon,
          bannerImages: ASSETS.cleaning.fullHome.banners,
          packages: [
            {
              name: '1 BHK Deep Home Cleaning',
              sectionTitle: 'Apartment Packages',
              badgeText: 'VALUE PACK',
              shortDescription: 'Top-to-bottom deep sanitization of 1 Bedroom, Living Room, Kitchen, and 1-2 Bathrooms',
              originalPrice: '3499.00',
              discountedPrice: '2499.00',
              savingsLabel: 'Save ₹1000 (29% off)',
              duration: '4-5 hours',
              pricePerUnitLabel: 'per apartment',
              cardImage: ASSETS.cleaning.fullHome.banners[0],
              detailBannerImages: ASSETS.cleaning.fullHome.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                'Complete floor machine scrubbing & buffing',
                'Balcony floor washing and railing wiping',
                'Ceiling fans, switchboards, tube lights & AC exterior wiped',
                'Window panes & mosquito mesh vacuumed and wiped',
              ],
              processTitle: 'Comprehensive 4-Stage Workflow',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Dry Dusting & Vacuuming',
                  description: 'Industrial suction vacuums capture deep dust from ceilings, curtain rods, and corners.',
                  imageUrl: ASSETS.cleaning.fullHome.steps[0],
                },
                {
                  stepNumber: 2,
                  title: 'Kitchen & Bath Disinfection',
                  description: 'Technicians tackle tiles, counters, exhaust fans, and commodes simultaneously.',
                  imageUrl: ASSETS.cleaning.fullHome.steps[1],
                },
                {
                  stepNumber: 3,
                  title: 'Single-Disc Floor Buffing',
                  description: 'All tiled or marble floors are mechanically scrubbed and buffed for a high-gloss finish.',
                  imageUrl: ASSETS.cleaning.fullHome.steps[2],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: ['1 Bedroom, Living Room, 1 Kitchen & up to 2 Bathrooms', 'Ceiling fan blades, light fixtures & AC exterior wipe', 'Window frames, glass panes & wire mesh cleaning', 'Machine floor scrubbing throughout the apartment'],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Unrestricted water & high-voltage power supply' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['Deep sofa or carpet shampooing is separate and can be bundled with this service.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'How many professionals will come?', answer: 'A team of 2 to 3 trained professionals equipped with single-disc scrubbers is deployed.' }],
            },
            {
              name: '2 BHK Deep Home Cleaning',
              sectionTitle: 'Apartment Packages',
              badgeText: 'MOST POPULAR',
              shortDescription: 'Full deep clean for 2 Bedrooms, Hall, Kitchen, Balconies, and up to 2 Bathrooms',
              originalPrice: '4999.00',
              discountedPrice: '3699.00',
              savingsLabel: 'Save ₹1300 (26% off)',
              duration: '5-6 hours',
              pricePerUnitLabel: 'per apartment',
              cardImage: ASSETS.cleaning.fullHome.banners[1],
              detailBannerImages: ASSETS.cleaning.fullHome.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                '2 Bedrooms + Living/Dining + Kitchen + 2 Bathrooms + Balcony',
                'Heavy-duty floor scrubbing with single-disc buffing machine',
                'Streak-free glass cleaning for all windows and sliders',
              ],
              processTitle: '5-Step Cleaning Protocol',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'High-Reach Dusting',
                  description: 'Cobweb removal, fan blades, top of wardrobes, and air conditioner vents.',
                  imageUrl: ASSETS.cleaning.fullHome.steps[0],
                },
                {
                  stepNumber: 2,
                  title: 'Mechanized Floor Buffing',
                  description: 'Entire house floors buffed with micro-abrasive pads.',
                  imageUrl: ASSETS.cleaning.fullHome.steps[1],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: ['Entire 2 BHK apartment deep cleaning', '2 Bathrooms sanitized and descaled', 'Balcony floor washed and drained'],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Access to all rooms throughout the duration' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['Exterior wall cleaning is not included.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'Can we stay in the home during cleaning?', answer: 'Yes! The team cleans room by room, allowing you to occupy another room comfortably.' }],
            },
          ],
        },
        {
          name: 'Sofa & Upholstery Cleaning',
          iconUrl: ASSETS.cleaning.sofa.icon,
          bannerImages: ASSETS.cleaning.sofa.banners,
          packages: [
            {
              name: '3-Seater Fabric Sofa Shampooing',
              sectionTitle: 'Sofa Shampooing',
              badgeText: 'TOP RATED',
              shortDescription: 'Deep injection-extraction wet shampooing to eliminate deep dust, food stains, and odors',
              originalPrice: '899.00',
              discountedPrice: '649.00',
              savingsLabel: 'Save ₹250 (28% off)',
              duration: '60 mins',
              pricePerUnitLabel: 'per 3-seater',
              cardImage: ASSETS.cleaning.sofa.banners[0],
              detailBannerImages: ASSETS.cleaning.sofa.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                'High-power dry vacuuming to remove deep-seated dust mites',
                'Foaming shampoo application with specialized fabric brush',
                'High-suction extraction lifts 90% moisture along with dissolved stains',
              ],
              processTitle: 'Our 3-Step Shampoo Process',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Dry Extraction',
                  description: 'Commercial 1400W vacuum extracts loose dirt, allergens, and dust mites from crevices.',
                  imageUrl: ASSETS.cleaning.sofa.steps[0],
                },
                {
                  stepNumber: 2,
                  title: 'Fabric Shampoo Agitation',
                  description: 'German non-ionic foam shampoo is worked into fabric fibers using soft-bristle agitators.',
                  imageUrl: ASSETS.cleaning.sofa.steps[1],
                },
                {
                  stepNumber: 3,
                  title: 'Moisture & Sludge Extraction',
                  description: 'Twin-motor extraction vacuum sucks out 90% of moisture and all dissolved stains.',
                  imageUrl: ASSETS.cleaning.sofa.steps[2],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: ['Full 3-seater fabric sofa (seats, backrests, and side armrests)', 'Stain spot-treatment for coffee/tea/food spills', 'Deodorizing spray application'],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Electrical socket within 5 meters' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['Please allow 3 to 4 hours under ceiling fan for complete drying.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'How long does the sofa take to dry?', answer: 'It dries completely within 3 to 4 hours under a regular ceiling fan.' }],
            },
          ],
        },
      ],
    },

    // ──────── CATEGORY 2: AC & APPLIANCE REPAIR ────────
    {
      name: 'AC & Appliance Repair',
      slug: 'ac-appliance-repair',
      iconUrl: ASSETS.acAppliance.catIcon,
      description: 'Expert diagnostics, foam jet service & genuine spare parts repair for home appliances',
      displayOrder: 2,
      subCategories: [
        {
          name: 'Air Conditioner (AC) Service',
          iconUrl: ASSETS.acAppliance.ac.icon,
          bannerImages: ASSETS.acAppliance.ac.banners,
          packages: [
            {
              name: 'Foam-Jet AC Power Service',
              sectionTitle: 'AC Servicing',
              badgeText: '2X COOLING',
              shortDescription: 'Deep indoor coil power jet wash with anti-fungal foam and high-pressure water',
              originalPrice: '799.00',
              discountedPrice: '549.00',
              savingsLabel: 'Save ₹250 (31% off)',
              duration: '45 mins',
              pricePerUnitLabel: 'per AC',
              cardImage: ASSETS.acAppliance.ac.banners[0],
              detailBannerImages: ASSETS.acAppliance.ac.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                '2X deeper coil cleaning using high-pressure foam jet wash',
                'Outdoor unit washed with high-pressure water spray',
                'Comprehensive 10-point cooling and gas level audit',
                'No-spill apron prevents water droplets on walls or floor',
              ],
              processTitle: 'Urban Foam-Jet Technique',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Apron Assembly & Prep',
                  description: 'Leak-proof plastic apron attached to AC to collect all dirty runoff into a bucket.',
                  imageUrl: ASSETS.acAppliance.ac.steps[0],
                },
                {
                  stepNumber: 2,
                  title: 'Foam Cleanser Application',
                  description: 'Antibacterial chemical foam dissolves clogged grease and dust between aluminum fins.',
                  imageUrl: ASSETS.acAppliance.ac.steps[1],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: ['Indoor unit disassembly and jet spray wash', 'Outdoor unit condenser coil jet wash', 'Filter, blower & drain tray decontamination'],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Working power point & water tap' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['Gas leak repair or PCB replacement is billed separately based on diagnosis.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'Does jet cleaning dirty my wall?', answer: 'Not at all. We mount a heavy-duty waterproof apron that funnels 100% of the water directly into a bucket.' }],
            },
            {
              name: 'AC Gas Leak Diagnosis & Refill',
              sectionTitle: 'AC Repairs',
              badgeText: 'GENUINE GAS',
              shortDescription: 'Nitrogen pressure testing, brazing leak repair, vacuuming and 100% pure gas charging',
              originalPrice: '2800.00',
              discountedPrice: '2299.00',
              savingsLabel: 'Save ₹501 (18% off)',
              duration: '90 mins',
              pricePerUnitLabel: 'per AC',
              cardImage: ASSETS.acAppliance.ac.banners[1],
              detailBannerImages: ASSETS.acAppliance.ac.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                'Certified R32 / R410A / R22 refrigerant gas filled by weight',
                'Nitrogen leak detection up to 350 PSI pressure',
                'Deep vacuuming with dual-stage vacuum pump',
              ],
              processTitle: 'Precision Gas Recharge',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Nitrogen Leak Test',
                  description: 'Nitrogen pressure injected to locate minute copper joint leaks.',
                  imageUrl: ASSETS.acAppliance.ac.steps[0],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: ['Leak soldering/brazing', 'System evacuation and vacuum test', 'Full gas top-up by weight with digital scale'],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Access to both indoor and outdoor units' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['Comes with our standard 60-day cooling and gas warranty.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'Is there a warranty on gas charging?', answer: 'Yes, we provide a 60-day warranty on complete gas recharge.' }],
            },
          ],
        },
        {
          name: 'Washing Machine Repair',
          iconUrl: ASSETS.acAppliance.washing.icon,
          bannerImages: ASSETS.acAppliance.washing.banners,
          packages: [
            {
              name: 'Washing Machine Checkup & Deep Clean',
              sectionTitle: 'Diagnostics & Tub Clean',
              badgeText: 'SAME DAY',
              shortDescription: 'Complete diagnostic check of motor, drum belt, PCB, inlet valve & chemical tub descaling',
              originalPrice: '499.00',
              discountedPrice: '299.00',
              savingsLabel: 'Save ₹200 (40% off)',
              duration: '45 mins',
              pricePerUnitLabel: 'per machine',
              cardImage: ASSETS.acAppliance.washing.banners[0],
              detailBannerImages: ASSETS.acAppliance.washing.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                'Vibration and noise diagnosis at high RPM spin',
                'Water drainage and pump lint filter cleaning',
                'Descaling powder wash to dissolve lime build-up inside outer tub',
              ],
              processTitle: 'Diagnostic Protocol',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Electronic Sensor Check',
                  description: 'Testing of water level sensor, lid switch, and PCB relay circuits.',
                  imageUrl: ASSETS.acAppliance.washing.steps[0],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: ['Complete diagnostics & fault finding', 'Lint filter & inlet valve mesh cleaning', 'Descaling cycle run'],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Active water inlet tap' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['Spare parts (valves, motor capacitor, belts) cost extra as per standardized rate card.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'What if my machine needs spare parts?', answer: 'The technician will inspect and provide an upfront quote before installing any genuine replacement parts.' }],
            },
          ],
        },
      ],
    },

    // ──────── CATEGORY 3: ELECTRICIAN, PLUMBER & CARPENTER ────────
    {
      name: 'Electrician, Plumber & Carpenter',
      slug: 'home-repairs-installations',
      iconUrl: ASSETS.homeRepairs.catIcon,
      description: 'Doorstep handy services for electrical fixes, plumbing leaks, fittings & carpentry woodwork',
      displayOrder: 3,
      subCategories: [
        {
          name: 'Electrician Services',
          iconUrl: ASSETS.homeRepairs.electric.icon,
          bannerImages: ASSETS.homeRepairs.electric.banners,
          packages: [
            {
              name: 'Ceiling Fan Installation & Repair',
              sectionTitle: 'Fan & Lighting',
              badgeText: 'EXPRESS',
              shortDescription: 'Mounting, downrod assembly, wiring connection, or capacitor/regulator replacement',
              originalPrice: '249.00',
              discountedPrice: '149.00',
              savingsLabel: 'Save ₹100 (40% off)',
              duration: '30 mins',
              pricePerUnitLabel: 'per fan',
              cardImage: ASSETS.homeRepairs.electric.banners[0],
              detailBannerImages: ASSETS.homeRepairs.electric.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                'Safe mounting with vibration-damping rubber bush',
                'Testing blade alignment and speed regulation',
                'Zero wobble safety inspection',
              ],
              processTitle: 'Installation Steps',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Bracket Mounting',
                  description: 'Heavy-duty shackle anchor bolted into ceiling hook securely.',
                  imageUrl: ASSETS.homeRepairs.electric.steps[0],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: ['Unboxing and blade assembly', 'Wiring connection with wire nuts', 'Testing forward and reverse spin'],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Ladder or sturdy table for ceiling access' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['New fan unit or additional wiring cable must be provided by the customer.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'Do you bring drill machines?', answer: 'Yes, our certified electricians carry industrial hammer drills and screw fasteners.' }],
            },
          ],
        },
        {
          name: 'Plumbing Services',
          iconUrl: ASSETS.homeRepairs.plumbing.icon,
          bannerImages: ASSETS.homeRepairs.plumbing.banners,
          packages: [
            {
              name: 'Tap & Mixer Replacement / Repair',
              sectionTitle: 'Taps & Mixers',
              badgeText: 'POPULAR',
              shortDescription: 'Fix dripping faucets, replace faulty spindles, or install brand new bath/kitchen mixers',
              originalPrice: '199.00',
              discountedPrice: '129.00',
              savingsLabel: 'Save ₹70 (35% off)',
              duration: '30 mins',
              pricePerUnitLabel: 'per tap',
              cardImage: ASSETS.homeRepairs.plumbing.banners[0],
              detailBannerImages: ASSETS.homeRepairs.plumbing.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                'Teflon tape sealing prevents future wall leakage',
                'Spindle washer replacement stops continuous dripping',
                'Pressure test of hot and cold diverters',
              ],
              processTitle: 'Plumbing Workflow',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Inlet Isolation',
                  description: 'Main control valve shut off to prevent water flooding.',
                  imageUrl: ASSETS.homeRepairs.plumbing.steps[0],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: ['Dismantling old tap fixture', 'Teflon wrapping & thread alignment', 'Leakage test after re-pressurizing'],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Location of main water valve' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['New tap or internal cartridge must be provided or purchased.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'Can the plumber bring the tap?', answer: 'Yes, if requested, the plumber can source standard branded taps from the local market.' }],
            },
          ],
        },
      ],
    },

    // ──────── CATEGORY 4: SALON FOR WOMEN ────────
    {
      name: 'Salon for Women',
      slug: 'salon-for-women',
      iconUrl: ASSETS.womenSalon.catIcon,
      description: 'Hygienic at-home salon experience: waxing, facials, manicure, pedicure & hair styling',
      displayOrder: 4,
      subCategories: [
        {
          name: 'Facials & Cleanups',
          iconUrl: ASSETS.womenSalon.facial.icon,
          bannerImages: ASSETS.womenSalon.facial.banners,
          packages: [
            {
              name: 'O3+ Brightening & Glow Facial',
              sectionTitle: 'Luxury Facials',
              badgeText: 'INSTANT GLOW',
              shortDescription: 'Multi-vitamin skin brightening treatment with steam, extraction, and peel-off mask',
              originalPrice: '2199.00',
              discountedPrice: '1699.00',
              savingsLabel: 'Save ₹500 (23% off)',
              duration: '75 mins',
              pricePerUnitLabel: 'per session',
              cardImage: ASSETS.womenSalon.facial.banners[0],
              detailBannerImages: ASSETS.womenSalon.facial.banners,
              highlightsTitle: 'Highlights',
              highlights: [
                '100% single-use sealed kit opened right in front of you',
                'Deep ultrasonic blackhead and whitehead extraction',
                'Relaxing lymphatic face, neck, and shoulder massage',
              ],
              processTitle: '6-Step Glow Treatment',
              processSteps: [
                {
                  stepNumber: 1,
                  title: 'Deep Cleansing & Steam',
                  description: 'Herbal cleanser removes makeup and environmental pollutants before warm steam opens pores.',
                  imageUrl: ASSETS.womenSalon.facial.steps[0],
                },
              ],
              whatsIncludedTitle: "What's Included",
              whatsIncluded: ['Cleansing, steam & ozone treatment', 'Gentle blackhead extraction', 'Soothing rubber peel-off mask', 'Neck, shoulder & back massage'],
              requirementsTitle: 'What We Need From You',
              requirements: [{ iconUrl: '', label: 'Bed or reclining chair for comfort' }],
              pleaseNoteTitle: 'Please Note',
              pleaseNote: ['Avoid direct sunlight for 6 hours post facial.'],
              faqsTitle: 'Frequently Asked Questions',
              faqs: [{ question: 'Are the products authentic?', answer: 'We strictly use 100% sealed single-use O3+ branded pouches.' }],
            },
          ],
        },
      ],
    },
  ];

  // 3. EXECUTE THE SEEDING
  for (const catData of UC_CATALOG) {
    console.log(`\n================================================================`);
    console.log(`Creating / Updating Category: "${catData.name}"`);
    console.log(`================================================================`);

    const category = await prisma.serviceCategory.upsert({
      where: { slug: catData.slug },
      update: {
        name: catData.name,
        iconUrl: catData.iconUrl,
        description: catData.description,
        displayOrder: catData.displayOrder,
        isActive: true,
        deletedAt: null,
      },
      create: {
        name: catData.name,
        slug: catData.slug,
        iconUrl: catData.iconUrl,
        description: catData.description,
        displayOrder: catData.displayOrder,
        isActive: true,
      },
    });

    console.log(`✓ Category Ready: ${category.name} (${category.id})`);

    // Process Sub-Categories
    for (let scIdx = 0; scIdx < catData.subCategories.length; scIdx++) {
      const scData = catData.subCategories[scIdx];

      let subCat = await prisma.serviceSubCategory.findFirst({
        where: {
          categoryId: category.id,
          name: scData.name,
        },
      });

      if (!subCat) {
        subCat = await prisma.serviceSubCategory.create({
          data: {
            categoryId: category.id,
            name: scData.name,
            iconUrl: scData.iconUrl,
            bannerImages: scData.bannerImages,
            displayOrder: scIdx,
            isActive: true,
          },
        });
        console.log(`  ✓ Created Sub-Category: "${subCat.name}" (${subCat.id})`);
      } else {
        subCat = await prisma.serviceSubCategory.update({
          where: { id: subCat.id },
          data: {
            iconUrl: scData.iconUrl,
            bannerImages: scData.bannerImages,
            displayOrder: scIdx,
            isActive: true,
          },
        });
        console.log(`  ✓ Updated Sub-Category: "${subCat.name}" (${subCat.id})`);
      }

      // Ensure backing service
      const baseSlug = scData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
      let service = await prisma.service.findFirst({
        where: { subCategoryId: subCat.id, deletedAt: null },
      });

      if (!service) {
        service = await prisma.service.create({
          data: {
            categoryId: category.id,
            subCategoryId: subCat.id,
            name: scData.name,
            slug: `${baseSlug}-${Date.now().toString().slice(-4)}`,
            description: `Professional ${scData.name} by background-verified experts`,
            iconUrl: scData.iconUrl,
            startingPrice: scData.packages[0]?.discountedPrice || '499.00',
            priceUnit: 'per service',
            durationText: scData.packages[0]?.duration || '60 mins',
            rating: 4.88,
            reviewCount: 230,
            isPopular: true,
            isActive: true,
          },
        });
        console.log(`  ✓ Created Backing Service: "${service.name}" (${service.id})`);
      } else {
        service = await prisma.service.update({
          where: { id: service.id },
          data: {
            name: scData.name,
            iconUrl: scData.iconUrl,
            startingPrice: scData.packages[0]?.discountedPrice || service.startingPrice,
            isActive: true,
          },
        });
        console.log(`  ✓ Updated Backing Service: "${service.name}" (${service.id})`);
      }

      // Process Packages
      for (let pIdx = 0; pIdx < scData.packages.length; pIdx++) {
        const pData = scData.packages[pIdx];

        let existingPkg = await prisma.servicePackage.findFirst({
          where: {
            serviceId: service.id,
            name: pData.name,
          },
        });

        const packagePayload = {
          name: pData.name,
          sectionTitle: pData.sectionTitle,
          badgeText: pData.badgeText,
          shortDescription: pData.shortDescription,
          originalPrice: pData.originalPrice,
          discountedPrice: pData.discountedPrice,
          savingsLabel: pData.savingsLabel,
          pricePerUnitLabel: pData.pricePerUnitLabel,
          duration: pData.duration,
          cardImage: pData.cardImage,
          detailBannerImages: pData.detailBannerImages,
          detailBannerVideo: null,
          offersBanner: null,
          highlightsTitle: pData.highlightsTitle,
          highlights: pData.highlights,
          processTitle: pData.processTitle,
          processSteps: pData.processSteps as any,
          whatsIncludedTitle: pData.whatsIncludedTitle,
          whatsIncluded: pData.whatsIncluded,
          requirementsTitle: pData.requirementsTitle,
          requirements: pData.requirements as any,
          pleaseNoteTitle: pData.pleaseNoteTitle,
          pleaseNote: pData.pleaseNote,
          faqsTitle: pData.faqsTitle,
          faqs: pData.faqs as any,
          reviews: [] as any,
          displayOrder: pIdx,
          isPopular: pIdx === 0,
          isActive: true,
          // Legacy compat
          title: pData.name,
          description: pData.shortDescription,
          price: pData.discountedPrice,
          features: pData.highlights as any,
        };

        if (!existingPkg) {
          existingPkg = await prisma.servicePackage.create({
            data: {
              serviceId: service.id,
              ...packagePayload,
            },
          });
          console.log(`    + Created Package: "${existingPkg.name}" [${pData.sectionTitle}] - ₹${pData.discountedPrice}`);
        } else {
          existingPkg = await prisma.servicePackage.update({
            where: { id: existingPkg.id },
            data: packagePayload,
          });
          console.log(`    ~ Updated Package: "${existingPkg.name}" [${pData.sectionTitle}] - ₹${pData.discountedPrice}`);
        }
      }
    }
  }

  console.log('\n🎉 ALL URBAN COMPANY SERVICES IMPORTED & TEST DATA REMOVED SUCCESSFULLY!');
}

main()
  .catch((e) => {
    console.error('Fatal error in seeding:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
