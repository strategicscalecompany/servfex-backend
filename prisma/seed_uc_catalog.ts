/**
 * Production catalog import (run once against MongoDB Atlas).
 *
 * - Archives duplicate services (same name, extra copies only)
 * - Upserts a unique UC-style catalog into the database
 * - Uploads all images to Cloudinary; stores only Cloudinary URLs
 * - Fills Super Admin package / subcategory fields
 *
 * Usage (from servfex admin/be):
 *   npx ts-node --transpile-only prisma/seed_uc_catalog.ts
 */
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

const u = (id: string, w = 1200) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=80`;

type Media = { icon: string; banners: string[]; steps: string[] };

const media = (icon: string, banners: string[], steps?: string[]): Media => ({
  icon,
  banners: banners.slice(0, 4),
  steps: (steps && steps.length ? steps : banners).slice(0, 4),
});

const M = {
  cleaning: media(u('photo-1581578731548-c64695cc6952', 400), [
    u('photo-1581578731548-c64695cc6952'),
    u('photo-1584820927498-cfe5211fd8bf'),
    u('photo-1600585154340-be6161a56a0c'),
    u('photo-1513694203232-719a280e022f'),
  ]),
  bathroom: media(u('photo-1584622650111-993a426fbf0a', 400), [
    u('photo-1584622650111-993a426fbf0a'),
    u('photo-1620626011761-996317b8d101'),
    u('photo-1552321554-5fefe8c9ef14'),
    u('photo-1600585154340-be6161a56a0c'),
  ]),
  kitchen: media(u('photo-1556911220-e15b29be8c8f', 400), [
    u('photo-1556911220-e15b29be8c8f'),
    u('photo-1588854337221-4cf9fa96059c'),
    u('photo-1507089947368-19c1da9775ae'),
    u('photo-1584820927498-cfe5211fd8bf'),
  ]),
  home: media(u('photo-1600585154340-be6161a56a0c', 400), [
    u('photo-1600585154340-be6161a56a0c'),
    u('photo-1600596542815-ffad4c1539a9'),
    u('photo-1513694203232-719a280e022f'),
    u('photo-1502672260266-1c1ef2d93688'),
  ]),
  sofa: media(u('photo-1555041469-a586c61ea9bc', 400), [
    u('photo-1555041469-a586c61ea9bc'),
    u('photo-1493663284031-b7e3aefcae8e'),
    u('photo-1586023492125-27b2c045efd7'),
    u('photo-1540574163026-643ea20ade25'),
  ]),
  pest: media(u('photo-1584820927498-cfe5211fd8bf', 400), [
    u('photo-1584820927498-cfe5211fd8bf'),
    u('photo-1581578731548-c64695cc6952'),
    u('photo-1600585154340-be6161a56a0c'),
  ]),
  ac: media(u('photo-1621905251189-08b45d6a269e', 400), [
    u('photo-1621905251189-08b45d6a269e'),
    u('photo-1581092160607-ee22621dd758'),
    u('photo-1571175443880-49e1d25b2bc5'),
  ]),
  wash: media(u('photo-1626806787461-102c1bfaaea1', 400), [
    u('photo-1626806787461-102c1bfaaea1'),
    u('photo-1581092160607-ee22621dd758'),
  ]),
  fridge: media(u('photo-1571175443880-49e1d25b2bc5', 400), [
    u('photo-1571175443880-49e1d25b2bc5'),
    u('photo-1581092160607-ee22621dd758'),
  ]),
  water: media(u('photo-1585704032915-c3400ca199e7', 400), [
    u('photo-1585704032915-c3400ca199e7'),
    u('photo-1581092160607-ee22621dd758'),
  ]),
  electric: media(u('photo-1621905252507-b35492cc74b4', 400), [
    u('photo-1621905252507-b35492cc74b4'),
    u('photo-1581244277943-fe4a9c777189'),
    u('photo-1581092160607-ee22621dd758'),
  ]),
  plumbing: media(u('photo-1585704032915-c3400ca199e7', 400), [
    u('photo-1585704032915-c3400ca199e7'),
    u('photo-1581244277943-fe4a9c777189'),
  ]),
  carpenter: media(u('photo-1533090161767-e6ffed986c88', 400), [
    u('photo-1533090161767-e6ffed986c88'),
    u('photo-1581244277943-fe4a9c777189'),
  ]),
  women: media(u('photo-1560066984-138dadb4c035', 400), [
    u('photo-1560066984-138dadb4c035'),
    u('photo-1570172619644-dfd03ed5d881'),
    u('photo-1519014816548-bf5fe059798b'),
    u('photo-1522337360788-8b13dee7a37e'),
  ]),
  facial: media(u('photo-1570172619644-dfd03ed5d881', 400), [
    u('photo-1570172619644-dfd03ed5d881'),
    u('photo-1560066984-138dadb4c035'),
  ]),
  nails: media(u('photo-1519014816548-bf5fe059798b', 400), [
    u('photo-1519014816548-bf5fe059798b'),
    u('photo-1560066984-138dadb4c035'),
  ]),
  hair: media(u('photo-1522337360788-8b13dee7a37e', 400), [
    u('photo-1522337360788-8b13dee7a37e'),
    u('photo-1560066984-138dadb4c035'),
  ]),
  men: media(u('photo-1503951914875-452162b0f3f1', 400), [
    u('photo-1503951914875-452162b0f3f1'),
    u('photo-1621605815971-fbc98d665033'),
    u('photo-1544161515-4ab6ce6db874'),
  ]),
  massage: media(u('photo-1544161515-4ab6ce6db874', 400), [
    u('photo-1544161515-4ab6ce6db874'),
    u('photo-1503951914875-452162b0f3f1'),
  ]),
  paint: media(u('photo-1589939705384-5185137a7f0f', 400), [
    u('photo-1589939705384-5185137a7f0f'),
    u('photo-1504307651254-35680f356dfd'),
    u('photo-1600585154340-be6161a56a0c'),
  ]),
  waterproof: media(u('photo-1504307651254-35680f356dfd', 400), [
    u('photo-1504307651254-35680f356dfd'),
    u('photo-1589939705384-5185137a7f0f'),
  ]),
};

type Faq = { question: string; answer: string };
type Review = { reviewerName: string; rating: number; comment: string; date: string };
type Step = { title: string; description: string };

interface PkgInput {
  name: string;
  sectionTitle: string;
  badgeText: string;
  short: string;
  original: number;
  discounted: number;
  duration: string;
  unit: string;
  media: Media;
  highlights: string[];
  process: Step[];
  included: string[];
  need: string[];
  notes: string[];
  faqs: Faq[];
}

interface BuiltPkg {
  name: string;
  sectionTitle: string;
  badgeText: string;
  shortDescription: string;
  originalPrice: string;
  discountedPrice: string;
  savingsLabel: string;
  duration: string;
  pricePerUnitLabel: string;
  media: Media;
  highlightsTitle: string;
  highlights: string[];
  processTitle: string;
  process: Step[];
  whatsIncludedTitle: string;
  whatsIncluded: string[];
  requirementsTitle: string;
  need: string[];
  pleaseNoteTitle: string;
  pleaseNote: string[];
  faqsTitle: string;
  faqs: Faq[];
}

interface ServiceInput {
  name: string;
  description: string;
  media: Media;
  packages: BuiltPkg[];
}

interface SubInput {
  name: string;
  media: Media;
  services: ServiceInput[];
}

interface CatInput {
  name: string;
  slug: string;
  description: string;
  media: Media;
  subCategories: SubInput[];
}

const rupee = (n: number) => n.toFixed(2);
const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const norm = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

function savingsLabel(original: number, discounted: number): string {
  const save = original - discounted;
  const pct = original > 0 ? Math.round((save / original) * 100) : 0;
  return `Save ₹${save} (${pct}% off)`;
}

function defaultReviews(serviceName: string): Review[] {
  return [
    {
      reviewerName: 'Ananya R.',
      rating: 5,
      comment: `Professional team and a clean finish. Booking ${serviceName} through ServFex was straightforward.`,
      date: '2026-09-18',
    },
    {
      reviewerName: 'Rahul M.',
      rating: 4,
      comment: `Arrived on time, explained the work, and left the area tidy. Would book ${serviceName} again.`,
      date: '2026-08-21',
    },
  ];
}

const uploadCache = new Map<string, string>();

const FALLBACK_IMAGE = u('photo-1600585154340-be6161a56a0c');

async function hostImage(url: string | null | undefined, folder: string): Promise<string> {
  const source = (url || '').trim();
  if (!source) return '';
  if (source.includes('res.cloudinary.com') || source.includes('cloudinary.com/')) return source;
  const cacheKey = `${folder}::${source}`;
  const cached = uploadCache.get(cacheKey);
  if (cached) return cached;

  const tryUpload = async (remote: string): Promise<string> => {
    const uploaded = await cloudinary.uploader.upload(remote, {
      folder,
      timeout: 120000,
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    });
    return uploaded.secure_url;
  };

  try {
    const hosted = await tryUpload(source);
    uploadCache.set(cacheKey, hosted);
    return hosted;
  } catch (error) {
    console.warn(`  Cloudinary retry with fallback for ${source.slice(0, 64)}`);
    const hosted = await tryUpload(FALLBACK_IMAGE);
    uploadCache.set(cacheKey, hosted);
    return hosted;
  }
}

async function hostList(urls: string[], folder: string): Promise<string[]> {
  const hosted: string[] = [];
  for (const url of urls) {
    const next = await hostImage(url, folder);
    if (next) hosted.push(next);
  }
  return hosted;
}

function pkg(input: PkgInput) {
  return {
    name: input.name,
    sectionTitle: input.sectionTitle,
    badgeText: input.badgeText,
    shortDescription: input.short,
    originalPrice: rupee(input.original),
    discountedPrice: rupee(input.discounted),
    savingsLabel: savingsLabel(input.original, input.discounted),
    duration: input.duration,
    pricePerUnitLabel: input.unit,
    media: input.media,
    highlightsTitle: 'Highlights',
    highlights: input.highlights,
    processTitle: 'Our Process',
    process: input.process,
    whatsIncludedTitle: "What's Included",
    whatsIncluded: input.included,
    requirementsTitle: 'What We Need From You',
    need: input.need,
    pleaseNoteTitle: 'Please Note',
    pleaseNote: input.notes,
    faqsTitle: 'Frequently Asked Questions',
    faqs: input.faqs,
  };
}

const CATALOG: CatInput[] = [
  {
    name: 'Cleaning & Pest Control',
    slug: 'cleaning-pest-control',
    description: 'Professional home, kitchen, bathroom, sofa cleaning and certified pest control',
    media: M.cleaning,
    subCategories: [
      {
        name: 'Bathroom & Toilet Cleaning',
        media: M.bathroom,
        services: [
          {
            name: 'Classic Bathroom Cleaning',
            description: 'Mechanised bathroom deep clean with descaling, sanitisation and floor drying',
            media: M.bathroom,
            packages: [
              pkg({
                name: 'Classic Bathroom Cleaning',
                sectionTitle: 'Intense Cleaning',
                badgeText: 'MOST POPULAR',
                short: 'Tile descaling, commode sanitisation, mirror polish and wet-vac floor dry',
                original: 699,
                discounted: 499,
                duration: '60 mins',
                unit: 'per bathroom',
                media: M.bathroom,
                highlights: [
                  'Hard-water stain treatment on tiles, taps and commode',
                  'Hospital-grade sanitisation of high-touch fittings',
                  'Rotary brush scrubbing on floor and wall tiles',
                  'Streak-free mirror and chrome finish',
                ],
                process: [
                  { title: 'Pre-treat and descale', description: 'Safe descaler is applied on tiles, commode and chrome to loosen mineral film.' },
                  { title: 'Machine scrub', description: 'Rotary brushes clean grout lines and floor tiles without damaging glaze.' },
                  { title: 'Fixtures and glass', description: 'Taps, shower, mirror and vanity are hand-buffed to a clean shine.' },
                  { title: 'Extract and sanitise', description: 'Standing water is vacuumed and the floor is left dry and deodorised.' },
                ],
                included: ['Commode interior and exterior', 'Wall tiles up to 7 ft', 'Washbasin, taps and mirror', 'Floor scrub and dry'],
                need: ['Running water', 'Power socket for the scrubber', 'Clear toiletries from the counter'],
                notes: ['Old yellow stains may lighten substantially but may not vanish fully.', 'Broken tiles or rusted chrome cannot be restored by cleaning.'],
                faqs: [
                  { question: 'How long does one bathroom take?', answer: 'A standard bathroom usually takes 60 to 75 minutes.' },
                  { question: 'Are the chemicals safe around kids and pets?', answer: 'We use registered, low-odour household-safe cleaners. Keep pets away until floors are dry.' },
                ],
              }),
              pkg({
                name: '2 Bathroom Combo Clean',
                sectionTitle: 'Intense Cleaning',
                badgeText: 'COMBO',
                short: 'Same intense bathroom protocol for two bathrooms in one visit',
                original: 1299,
                discounted: 899,
                duration: '120 mins',
                unit: 'for 2 bathrooms',
                media: M.bathroom,
                highlights: ['Two bathrooms in one booking', 'Same descaling and sanitising protocol', 'Shared travel, lower combined price'],
                process: [
                  { title: 'Scope both bathrooms', description: 'Technician checks water, power and access in both bathrooms first.' },
                  { title: 'Deep clean bathroom 1', description: 'Full descaling, scrubbing and drying cycle is completed.' },
                  { title: 'Deep clean bathroom 2', description: 'The same workflow is repeated in the second bathroom.' },
                  { title: 'Final walkthrough', description: 'Both bathrooms are checked with you before the team leaves.' },
                ],
                included: ['Two full bathroom cleans', 'Commode, tiles, basin and floor', 'Mirror and chrome polish'],
                need: ['Access to both bathrooms', 'Water and electricity'],
                notes: ['Attached toilets and powder rooms both count as bathrooms.'],
                faqs: [{ question: 'Can I add a third bathroom on site?', answer: 'Yes, extra bathrooms can be added at the listed per-bathroom rate.' }],
              }),
            ],
          },
          {
            name: 'Move-in Bathroom Restoration',
            description: 'Heavier bathroom restoration for long-uncleaned or newly vacated homes',
            media: M.bathroom,
            packages: [
              pkg({
                name: 'Move-in / Move-out Bathroom Deep Clean',
                sectionTitle: 'Restoration',
                badgeText: 'DEEP RESTORE',
                short: 'Double-pass scrub, drain flush and ceiling cobweb removal for neglected bathrooms',
                original: 1099,
                discounted: 799,
                duration: '90 mins',
                unit: 'per bathroom',
                media: M.bathroom,
                highlights: ['Double-pass machine scrub', 'Drain odour treatment', 'Ceiling cobweb and exhaust wipe'],
                process: [
                  { title: 'Heavy scale soak', description: 'A longer dwell time loosens stubborn mineral and soap film.' },
                  { title: 'Double rotary pass', description: 'Floor and walls are machine-scrubbed twice for extra grit removal.' },
                  { title: 'Drain and high areas', description: 'Trap flush, exhaust wipe and ceiling cobwebs are completed.' },
                  { title: 'Dry and hand over', description: 'Water is extracted and the bathroom is left ready to use.' },
                ],
                included: ['Full-height tile scrub', 'Commode and flush tank exterior', 'Drain flush and floor dry'],
                need: ['Uninterrupted water and power', 'Empty counters'],
                notes: ['This is a cleaning restoration, not a civil or plumbing repair.'],
                faqs: [{ question: 'Will severe yellow stains disappear?', answer: 'Most mineral film lifts. Deeply etched glaze may retain a faint mark.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Kitchen Deep Cleaning',
        media: M.kitchen,
        services: [
          {
            name: 'Kitchen Deep Cleaning',
            description: 'Degrease stove, tiles, cabinets and sink with food-safe cleaners',
            media: M.kitchen,
            packages: [
              pkg({
                name: 'Complete Kitchen Deep Clean',
                sectionTitle: 'Kitchen Cleaning',
                badgeText: 'BESTSELLER',
                short: 'Oil, carbon and grime removal from stove, tiles, cabinets and sink',
                original: 1899,
                discounted: 1399,
                duration: '120 mins',
                unit: 'per kitchen',
                media: M.kitchen,
                highlights: ['Stove, burners and drip trays degreased', 'Backsplash tiles cleaned of oil film', 'Cabinet exteriors wiped', 'Sink descaled'],
                process: [
                  { title: 'Degreaser dwell', description: 'Alkaline foam is applied on stove, tiles and greasy zones.' },
                  { title: 'Non-scratch scrub', description: 'Nylon pads lift carbon without dulling stainless steel.' },
                  { title: 'Cabinets and appliances', description: 'Door fronts, handles and appliance exteriors are detailed.' },
                  { title: 'Sanitise counters', description: 'Counters and sink are disinfected and dried.' },
                ],
                included: ['Gas stove and burner rings', 'Wall tiles', 'Cabinet exteriors', 'Sink and tap'],
                need: ['Clear spices and utensils from counters', 'Water and electricity'],
                notes: ['Inside cabinets is included only if shelves are emptied before arrival.'],
                faqs: [{ question: 'Do you clean the chimney filter?', answer: 'Chimney filter degreasing is a separate service and can be added.' }],
              }),
            ],
          },
          {
            name: 'Chimney & Stove Degreasing',
            description: 'Heavy grease removal from chimney filters, hood and gas stove',
            media: M.kitchen,
            packages: [
              pkg({
                name: 'Chimney Filter and Stove Degrease',
                sectionTitle: 'Kitchen Cleaning',
                badgeText: 'GREASE CUT',
                short: 'Filter soak, hood wipe and stove carbon removal for cooking-heavy kitchens',
                original: 1299,
                discounted: 949,
                duration: '75 mins',
                unit: 'per kitchen',
                media: M.kitchen,
                highlights: ['Mesh filters soaked and rinsed', 'Hood exterior degreased', 'Burner rings and drip trays restored'],
                process: [
                  { title: 'Remove filters', description: 'Chimney filters are taken down for a dedicated soak.' },
                  { title: 'Stove carbon lift', description: 'Burners and trays are degreased and rinsed.' },
                  { title: 'Hood wipe', description: 'The canopy exterior is cleaned of sticky oil film.' },
                  { title: 'Refit and check', description: 'Dry filters are refitted and the stove is wiped ready to use.' },
                ],
                included: ['Chimney filter soak', 'Hood exterior', 'Stove top, knobs and trays'],
                need: ['Stepladder or stool', 'Clear stove top'],
                notes: ['Internal motor servicing is not included.'],
                faqs: [{ question: 'Can very old sticky filters be restored?', answer: 'Most mesh filters clean well. Damaged or melted filters should be replaced.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Full Home Deep Cleaning',
        media: M.home,
        services: [
          {
            name: '1 BHK Deep Home Cleaning',
            description: 'Dusting, mopping, kitchen and bathroom deep clean for a 1 BHK',
            media: M.home,
            packages: [
              pkg({
                name: '1 BHK Deep Home Cleaning',
                sectionTitle: 'Apartment Packages',
                badgeText: 'COMPACT HOME',
                short: '1 bedroom, hall, kitchen, balcony and 1 bathroom deep clean',
                original: 3499,
                discounted: 2499,
                duration: '4 hrs',
                unit: 'per home',
                media: M.home,
                highlights: ['Ceiling-to-floor dusting', 'Kitchen degrease', '1 bathroom deep clean', 'Floor mop and dry'],
                process: [
                  { title: 'Protect and dry dust', description: 'Fans, corners and furniture tops are dusted first.' },
                  { title: 'Kitchen and bath', description: 'Wet deep-clean zones are completed with machines where needed.' },
                  { title: 'Rooms and hall', description: 'Surfaces, skirting and floors are wiped and mopped.' },
                  { title: 'Handover', description: 'A room-by-room walkthrough is done with you.' },
                ],
                included: ['1 bedroom and hall', 'Kitchen exterior clean', '1 bathroom', 'Balcony dry wipe'],
                need: ['Water and electricity', 'Parking for the team if possible'],
                notes: ['Interior of occupied wardrobes is skipped unless emptied.'],
                faqs: [{ question: 'How many people come?', answer: 'Usually a 2-member crew for a 1 BHK.' }],
              }),
            ],
          },
          {
            name: '2 BHK Deep Home Cleaning',
            description: 'Full apartment deep clean covering rooms, kitchen and up to 2 bathrooms',
            media: M.home,
            packages: [
              pkg({
                name: '2 BHK Deep Home Cleaning',
                sectionTitle: 'Apartment Packages',
                badgeText: 'MOST POPULAR',
                short: '2 bedrooms, hall, kitchen, balconies and up to 2 bathrooms',
                original: 4999,
                discounted: 3499,
                duration: '6 hrs',
                unit: 'per home',
                media: M.home,
                highlights: ['Two bathrooms included', 'Kitchen degrease', 'Fan, window and skirting wipe', 'Floor mop'],
                process: [
                  { title: 'Walkthrough', description: 'Scope, water points and fragile items are confirmed.' },
                  { title: 'Wet zones', description: 'Kitchen and bathrooms are deep cleaned first.' },
                  { title: 'Dry zones', description: 'Bedrooms and living areas are dusted and mopped.' },
                  { title: 'Final check', description: 'Missed corners are corrected before the team leaves.' },
                ],
                included: ['2 bedrooms and hall', 'Kitchen', 'Up to 2 bathrooms', 'Balcony wipe'],
                need: ['Someone at home for the duration', 'Water and power'],
                notes: ['Sofa shampooing is not included and can be added separately.'],
                faqs: [{ question: 'Can you do it while we stay home?', answer: 'Yes. We work room by room so you can shift to another space.' }],
              }),
            ],
          },
          {
            name: '3 BHK Deep Home Cleaning',
            description: 'Larger home deep clean for 3 bedrooms, living areas and bathrooms',
            media: M.home,
            packages: [
              pkg({
                name: '3 BHK Deep Home Cleaning',
                sectionTitle: 'Apartment Packages',
                badgeText: 'FAMILY HOME',
                short: '3 bedrooms, living, kitchen, balconies and up to 3 bathrooms',
                original: 6499,
                discounted: 4499,
                duration: '8 hrs',
                unit: 'per home',
                media: M.home,
                highlights: ['Larger crew for a full-day clean', 'Up to 3 bathrooms', 'Kitchen and living deep clean'],
                process: [
                  { title: 'Zone plan', description: 'The home is split so wet and dry work can run in parallel.' },
                  { title: 'Deep clean wet areas', description: 'Kitchen and bathrooms are completed with machines.' },
                  { title: 'Rooms and living', description: 'Dusting, wiping and mopping across all bedrooms.' },
                  { title: 'Handover', description: 'A full walkthrough closes the job.' },
                ],
                included: ['3 bedrooms', 'Living and dining', 'Kitchen', 'Up to 3 bathrooms'],
                need: ['All-day access', 'Water and electricity'],
                notes: ['Store rooms packed floor-to-ceiling are dusted only on exposed surfaces.'],
                faqs: [{ question: 'Do you move heavy furniture?', answer: 'We pull light furniture. Wardrobes and large beds stay in place.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Sofa & Upholstery Cleaning',
        media: M.sofa,
        services: [
          {
            name: 'Sofa Shampooing',
            description: 'Fabric or leather sofa shampoo, stain treatment and wet vacuum extraction',
            media: M.sofa,
            packages: [
              pkg({
                name: '3-Seater Fabric Sofa Shampooing',
                sectionTitle: 'Upholstery',
                badgeText: 'FRESH FABRIC',
                short: 'Shampoo, stain lift and extraction for a 3-seater sofa',
                original: 999,
                discounted: 699,
                duration: '75 mins',
                unit: 'per sofa',
                media: M.sofa,
                highlights: ['Fabric-safe shampoo', 'Wet-vac extraction', 'Cushion and base cleaning'],
                process: [
                  { title: 'Vacuum', description: 'Dust and crumbs are lifted from seams and under cushions.' },
                  { title: 'Spot treat', description: 'Visible stains are pre-treated before the full wash.' },
                  { title: 'Shampoo and extract', description: 'Foam is worked in and pulled out with a wet vacuum.' },
                  { title: 'Dry advise', description: 'You get drying time guidance before sitting back.' },
                ],
                included: ['3-seater body', 'Seat and back cushions', 'Arm rests'],
                need: ['Power socket near the sofa', 'Space to pull the sofa slightly forward'],
                notes: ['Silk, velvet and some leather types need a patch test first.'],
                faqs: [{ question: 'How long until we can sit?', answer: 'Usually 4 to 8 hours depending on humidity and fabric.' }],
              }),
              pkg({
                name: '5-Seater Sofa Set Shampooing',
                sectionTitle: 'Upholstery',
                badgeText: 'FAMILY SET',
                short: 'Shampoo and extraction for a 5-seater sofa set',
                original: 1599,
                discounted: 1099,
                duration: '120 mins',
                unit: 'per set',
                media: M.sofa,
                highlights: ['Full 5-seater set', 'Stain pre-treatment', 'Extraction dry-down'],
                process: [
                  { title: 'Inspect fabric', description: 'Material type and colour-fastness are checked.' },
                  { title: 'Vacuum and pre-treat', description: 'Dust is removed and marks are treated.' },
                  { title: 'Wash each piece', description: 'Every seat is shampooed and extracted.' },
                  { title: 'Arrange and advise', description: 'Cushions are set back and drying time is shared.' },
                ],
                included: ['Up to 5 seats', 'Cushions', 'Visible stain treatment'],
                need: ['Power', 'Clear path around the sofa'],
                notes: ['Recliners with electrical parts are cleaned on fabric only.'],
                faqs: [{ question: 'Are ottomans included?', answer: 'One matching ottoman can be added at a small extra charge.' }],
              }),
            ],
          },
          {
            name: 'Mattress Cleaning',
            description: 'Mattress surface shampoo, dust extraction and sanitising spray',
            media: M.sofa,
            packages: [
              pkg({
                name: 'Single / Queen Mattress Clean',
                sectionTitle: 'Upholstery',
                badgeText: 'HYGIENE',
                short: 'Surface shampoo and sanitising for one mattress',
                original: 899,
                discounted: 649,
                duration: '60 mins',
                unit: 'per mattress',
                media: M.sofa,
                highlights: ['Dust mite vacuum pass', 'Surface shampoo', 'Sanitising spray'],
                process: [
                  { title: 'Strip and vacuum', description: 'Bedding is set aside and both faces are vacuumed if accessible.' },
                  { title: 'Spot treat', description: 'Body-oil and spill marks are pre-treated.' },
                  { title: 'Shampoo and extract', description: 'A light foam clean is extracted so the core stays drier.' },
                  { title: 'Sanitise', description: 'A fabric-safe sanitiser is sprayed before drying.' },
                ],
                included: ['One mattress surface clean', 'Spot treatment', 'Sanitising spray'],
                need: ['Mattress accessible on a bed or floor', 'Power'],
                notes: ['Deep internal soaking is avoided to protect foam.'],
                faqs: [{ question: 'Do you clean both sides?', answer: 'Yes if the mattress can be flipped safely with your help.' }],
              }),
            ],
          },
          {
            name: 'Carpet Cleaning',
            description: 'Area rug or room carpet shampoo with extraction',
            media: M.sofa,
            packages: [
              pkg({
                name: 'Room Carpet / Rug Shampoo',
                sectionTitle: 'Upholstery',
                badgeText: 'FRESH RUG',
                short: 'Vacuum, shampoo and extraction for one medium carpet or rug',
                original: 1299,
                discounted: 899,
                duration: '90 mins',
                unit: 'per carpet',
                media: M.sofa,
                highlights: ['Deep vacuum', 'Shampoo and extract', 'Edge and fringe care'],
                process: [
                  { title: 'Dry soil removal', description: 'Loose grit is vacuumed from the pile.' },
                  { title: 'Shampoo', description: 'Carpet-safe foam is worked into the fibres.' },
                  { title: 'Extract', description: 'Dirty water is pulled out with a wet vacuum.' },
                  { title: 'Groom pile', description: 'The pile is set and drying time is explained.' },
                ],
                included: ['One carpet or rug up to 6x9 ft', 'Spot treatment', 'Extraction'],
                need: ['Power and water', 'Clear furniture off the rug if possible'],
                notes: ['Antique silk rugs need a material check before wet cleaning.'],
                faqs: [{ question: 'Will colours bleed?', answer: 'We do a corner colour-fast test first and stop if dye lifts.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Pest Control Services',
        media: M.pest,
        services: [
          {
            name: 'Cockroach Control',
            description: 'Gel bait and spray treatment for cockroaches and ants in kitchens and baths',
            media: M.pest,
            packages: [
              pkg({
                name: 'Cockroach and Ant Gel Treatment',
                sectionTitle: 'Pest Control',
                badgeText: 'KITCHEN SAFE',
                short: 'Targeted gel baits plus crack-and-crevice spray for crawling insects',
                original: 1499,
                discounted: 999,
                duration: '60 mins',
                unit: 'per home',
                media: M.pest,
                highlights: ['Gel baits in kitchen hotspots', 'Crack and crevice spray', 'Follow-up guidance'],
                process: [
                  { title: 'Inspect', description: 'Kitchen, bathrooms and utility areas are checked for activity.' },
                  { title: 'Place gel', description: 'Medical-grade gel baits go into hinges, plinths and wet corners.' },
                  { title: 'Treat cracks', description: 'A residual spray is applied in voids, not on dishes or food.' },
                  { title: 'Advise', description: 'You get a short do-and-dont list for 48 hours.' },
                ],
                included: ['Kitchen and bathrooms', 'Gel baiting', 'Crack spray'],
                need: ['Clear under-sink access', 'Put food away'],
                notes: ['Keep pets off wet treated floors until dry.'],
                faqs: [{ question: 'When will I see fewer cockroaches?', answer: 'Activity often drops in 2 to 7 days as bait is carried back to the harbourages.' }],
              }),
            ],
          },
          {
            name: 'Bed Bug Control',
            description: 'Mattress, sofa and bed-frame treatment for bed bugs',
            media: M.pest,
            packages: [
              pkg({
                name: 'Bed Bug Heat-Assist Treatment',
                sectionTitle: 'Pest Control',
                badgeText: 'BEDROOM',
                short: 'Mattress, bed frame and nearby furniture treatment for bed bugs',
                original: 2499,
                discounted: 1799,
                duration: '90 mins',
                unit: 'per bedroom',
                media: M.pest,
                highlights: ['Mattress and frame treatment', 'Sofa check in the same room', 'Re-infestation advice'],
                process: [
                  { title: 'Inspect seams', description: 'Mattress piping, headboard and skirting are checked.' },
                  { title: 'Treat rest spots', description: 'Approved chemical is applied to frames, not on your skin-contact sheet if you prefer a cover.' },
                  { title: 'Hot spots', description: 'Nearby sofas and carpets in the same room are treated if needed.' },
                  { title: 'Aftercare', description: 'Washing and vacuuming steps are explained.' },
                ],
                included: ['One bedroom mattress and frame', 'Immediate surrounding furniture'],
                need: ['Strip the bed', 'Wash bedding on hot cycle after service'],
                notes: ['Severe infestations may need a follow-up visit.'],
                faqs: [{ question: 'Can I sleep there the same night?', answer: 'Yes after the treated surfaces are dry and you use clean washed linen.' }],
              }),
            ],
          },
          {
            name: 'Termite Control',
            description: 'Wood and soil termite inspection with chemical barrier treatment',
            media: M.pest,
            packages: [
              pkg({
                name: 'Termite Inspection and Barrier Treatment',
                sectionTitle: 'Pest Control',
                badgeText: 'WOOD GUARD',
                short: 'Drill-and-fill or surface barrier treatment for active termite signs',
                original: 4999,
                discounted: 3499,
                duration: '3 hrs',
                unit: 'per home',
                media: M.pest,
                highlights: ['Visual wood inspection', 'Targeted chemical barrier', 'Treatment map for your home'],
                process: [
                  { title: 'Survey wood', description: 'Doors, frames, cabinets and damp walls are inspected.' },
                  { title: 'Mark active zones', description: 'Mud tubes and hollow wood are documented.' },
                  { title: 'Treat', description: 'Approved termiticide is injected or applied as a barrier.' },
                  { title: 'Seal and brief', description: 'Drill points are sealed and aftercare is shared.' },
                ],
                included: ['Inspection', 'Treatment of identified zones', 'Basic sealing of drill points'],
                need: ['Access to skirting and door frames', 'Someone to approve drill points'],
                notes: ['Structural wood replacement is not included.'],
                faqs: [{ question: 'Is this a lifetime warranty job?', answer: 'This is a treatment visit. Multi-year AMC can be discussed after inspection.' }],
              }),
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'AC & Appliance Repair',
    slug: 'ac-appliance-repair',
    description: 'Expert diagnostics, foam-jet service and spare-parts repair for home appliances',
    media: M.ac,
    subCategories: [
      {
        name: 'Air Conditioner (AC) Service',
        media: M.ac,
        services: [
          {
            name: 'AC Foam Jet Service',
            description: 'Foam-jet indoor and outdoor AC service with basic diagnosis',
            media: M.ac,
            packages: [
              pkg({
                name: 'Foam-jet service (1 AC)',
                sectionTitle: 'AC Service',
                badgeText: 'POWER CLEAN',
                short: 'Indoor foam clean, outdoor jet and performance check for one split or window AC',
                original: 699,
                discounted: 499,
                duration: '60 mins',
                unit: 'per AC',
                media: M.ac,
                highlights: ['Indoor coil foam clean', 'Outdoor unit dust jet', 'Cooling performance check'],
                process: [
                  { title: 'Diagnose', description: 'Power, cooling and unusual noise are checked first.' },
                  { title: 'Foam indoor', description: 'Evaporator fins are foamed and rinsed as per unit type.' },
                  { title: 'Jet outdoor', description: 'The outdoor condenser is dusted with a pressure jet where access exists.' },
                  { title: 'Test cool', description: 'The AC is run and basic readings are shared.' },
                ],
                included: ['1 indoor unit', '1 outdoor unit if accessible', 'Basic diagnosis'],
                need: ['Water', 'Power', 'Stool or ladder', 'Clear area under the indoor unit'],
                notes: ['Gas refill is not included in foam-jet service.'],
                faqs: [{ question: 'Window and split both covered?', answer: 'Yes. Mention the type while booking so the right kit is carried.' }],
              }),
              pkg({
                name: 'Foam-jet service (2 ACs)',
                sectionTitle: 'AC Service',
                badgeText: 'COMBO',
                short: 'Foam-jet power service for two AC units in one visit',
                original: 1299,
                discounted: 899,
                duration: '120 mins',
                unit: 'for 2 ACs',
                media: M.ac,
                highlights: ['Two units, one visit', 'Indoor and outdoor clean', 'Shared diagnosis'],
                process: [
                  { title: 'Inspect both units', description: 'Model, access and issues are noted for each AC.' },
                  { title: 'Service unit 1', description: 'Foam-jet cycle is completed.' },
                  { title: 'Service unit 2', description: 'The same cycle is repeated.' },
                  { title: 'Cooling test', description: 'Both units are run and findings are explained.' },
                ],
                included: ['2 AC foam-jet services', 'Basic diagnosis'],
                need: ['Water and power', 'Access to both outdoor units if possible'],
                notes: ['Indoor units on very high walls may need extra safety setup.'],
                faqs: [{ question: 'What if one AC needs gas?', answer: 'Gas leak checks and refill are quoted separately after diagnosis.' }],
              }),
            ],
          },
          {
            name: 'AC Repair & Gas Refill',
            description: 'Cooling diagnosis, leak check and gas top-up when required',
            media: M.ac,
            packages: [
              pkg({
                name: 'AC Gas Leak Diagnosis and Refill',
                sectionTitle: 'AC Repair',
                badgeText: 'COOLING FIX',
                short: 'Leak check, vacuum if needed and refrigerant top-up after diagnosis',
                original: 2499,
                discounted: 1799,
                duration: '90 mins',
                unit: 'per AC',
                media: M.ac,
                highlights: ['Leak diagnosis', 'Gas top-up after confirmation', 'Cooling retest'],
                process: [
                  { title: 'Gauge and inspect', description: 'Pressures, ice-up and outdoor behaviour are checked.' },
                  { title: 'Find leak', description: 'Joints and valves are inspected before adding gas.' },
                  { title: 'Charge', description: 'Refrigerant is added only if the system can hold it.' },
                  { title: 'Verify cooling', description: 'Room pull-down is checked with you.' },
                ],
                included: ['Diagnosis', 'Gas top-up if leak is manageable', 'Cooling test'],
                need: ['Stable power', 'Outdoor unit access'],
                notes: ['Major coil replacement is quoted separately. Gas brand/type follows the machine.'],
                faqs: [{ question: 'Is gas included in the price?', answer: 'The listed price covers diagnosis plus a standard top-up. Extra gas volume is shown before adding.' }],
              }),
            ],
          },
          {
            name: 'AC Installation',
            description: 'Split AC indoor and outdoor installation with copper and drain routing',
            media: M.ac,
            packages: [
              pkg({
                name: 'Split AC Standard Installation',
                sectionTitle: 'AC Install',
                badgeText: 'NEW UNIT',
                short: 'Indoor mount, outdoor stand, copper piping within standard length and drain',
                original: 2499,
                discounted: 1999,
                duration: '3 hrs',
                unit: 'per AC',
                media: M.ac,
                highlights: ['Indoor and outdoor mounting', 'Standard copper and drain', 'Vacuum and test cool'],
                process: [
                  { title: 'Mark positions', description: 'Indoor height and outdoor stand location are agreed.' },
                  { title: 'Core and mount', description: 'Wall core, indoor plate and outdoor stand are fixed.' },
                  { title: 'Connect', description: 'Copper, drain and electrical are routed and flared.' },
                  { title: 'Vacuum and start', description: 'The system is evacuated and test-run.' },
                ],
                included: ['Standard install kit labour', 'Indoor and outdoor mounting', 'Test run'],
                need: ['AC already at site', 'Clear wall and balcony access', 'Stabiliser if required by brand'],
                notes: ['Extra copper, core cutting through thick walls or outdoor stands on MS frames may cost extra.'],
                faqs: [{ question: 'Do you carry the copper?', answer: 'A standard length is included. Extra metres are charged after measuring the run.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Washing Machine Repair',
        media: M.wash,
        services: [
          {
            name: 'Washing Machine Repair',
            description: 'Diagnosis and repair for top-load and front-load washing machines',
            media: M.wash,
            packages: [
              pkg({
                name: 'Washing Machine Checkup and Repair',
                sectionTitle: 'Appliance Repair',
                badgeText: 'DIAGNOSE FIRST',
                short: 'Fault finding for spin, drain, water-fill and noise issues',
                original: 299,
                discounted: 199,
                duration: '60 mins',
                unit: 'per machine',
                media: M.wash,
                highlights: ['On-site diagnosis', 'Spare quote before fitment', 'Test wash if parts are ready'],
                process: [
                  { title: 'Listen and inspect', description: 'Error codes, inlet, drain and drum movement are checked.' },
                  { title: 'Quote parts', description: 'Any spare is shown and priced before fitment.' },
                  { title: 'Repair', description: 'Approved parts are fitted or a setting is corrected.' },
                  { title: 'Test cycle', description: 'A short wash or spin is run when safe.' },
                ],
                included: ['Diagnosis visit', 'Minor setting or cleaning fixes'],
                need: ['Water and power', 'Machine accessible'],
                notes: ['Spares are extra and used only after your approval.'],
                faqs: [{ question: 'Do you repair both top and front load?', answer: 'Yes, including semi-automatic models.' }],
              }),
            ],
          },
          {
            name: 'Washing Machine Deep Clean',
            description: 'Drum, gasket and detergent-drawer hygiene clean',
            media: M.wash,
            packages: [
              pkg({
                name: 'Front Load Drum and Gasket Clean',
                sectionTitle: 'Appliance Care',
                badgeText: 'HYGIENE',
                short: 'Gasket, drum and drawer clean to reduce odour and residue',
                original: 799,
                discounted: 549,
                duration: '60 mins',
                unit: 'per machine',
                media: M.wash,
                highlights: ['Door gasket clean', 'Detergent drawer soak', 'Drum hygiene cycle'],
                process: [
                  { title: 'Inspect mould spots', description: 'Gasket folds and drawer are checked.' },
                  { title: 'Manual clean', description: 'Residue and biofilm are wiped from reachable parts.' },
                  { title: 'Hygiene wash', description: 'A hot cleaner cycle is run if the machine allows it.' },
                  { title: 'Dry gasket', description: 'The door is left ajar guidance is shared.' },
                ],
                included: ['Gasket and door glass', 'Detergent drawer', 'Drum surface'],
                need: ['Empty drum', 'Hot wash option if available'],
                notes: ['Internal heater or PCB faults are a repair job, not this clean.'],
                faqs: [{ question: 'Will the rubber smell go?', answer: 'Most odours drop after a gasket clean plus a hot empty wash.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Refrigerator Repair',
        media: M.fridge,
        services: [
          {
            name: 'Refrigerator Repair',
            description: 'Cooling diagnosis for single and double-door refrigerators',
            media: M.fridge,
            packages: [
              pkg({
                name: 'Refrigerator Cooling Diagnosis',
                sectionTitle: 'Appliance Repair',
                badgeText: 'COOLING CHECK',
                short: 'Compressor, thermostat and frost issues checked on site',
                original: 299,
                discounted: 199,
                duration: '60 mins',
                unit: 'per fridge',
                media: M.fridge,
                highlights: ['Cooling complaint diagnosis', 'Spare quote before work', 'Safety power check'],
                process: [
                  { title: 'Measure cooling', description: 'Fridge and freezer performance are checked.' },
                  { title: 'Inspect', description: 'Vents, door seal and compressor start are reviewed.' },
                  { title: 'Quote', description: 'Gas or spare work is priced only if needed.' },
                  { title: 'Fix minor issues', description: 'Settings, drain and seal seating are corrected when possible.' },
                ],
                included: ['On-site diagnosis', 'Minor setting fixes'],
                need: ['Power', 'Some food can stay inside unless a long repair is needed'],
                notes: ['Gas charging and compressor jobs are extra after diagnosis.'],
                faqs: [{ question: 'Can you repair inverter fridges?', answer: 'Yes. Board-level parts may need a follow-up if not in the van kit.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Water Purifier (RO) Service',
        media: M.water,
        services: [
          {
            name: 'RO Water Purifier Service',
            description: 'Filter health check, replacement quote and sanitisation of the purifier',
            media: M.water,
            packages: [
              pkg({
                name: 'Complete RO Filter Service',
                sectionTitle: 'Water Purifier',
                badgeText: 'WATER CARE',
                short: 'Inspection, tank sanitise and filter replacement on approval',
                original: 499,
                discounted: 349,
                duration: '60 mins',
                unit: 'per purifier',
                media: M.water,
                highlights: ['TDS check', 'Filter life assessment', 'Tank rinse'],
                process: [
                  { title: 'TDS and leak check', description: 'Input/output TDS and joints are measured.' },
                  { title: 'Open and inspect', description: 'Pre-filters and membrane housing are reviewed.' },
                  { title: 'Replace on approval', description: 'Due filters are changed only after you confirm the price.' },
                  { title: 'Flush and sanitise', description: 'The tank is rinsed and the unit is leak-tested.' },
                ],
                included: ['Service visit', 'TDS reading', 'Sanitisation'],
                need: ['Water supply', 'Power to the purifier', 'Access under the sink'],
                notes: ['Filters and membrane cost extra based on brand and stage.'],
                faqs: [{ question: 'Do you service all brands?', answer: 'Most domestic RO/UV units. Mention the brand while booking.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Geyser & Microwave Repair',
        media: M.water,
        services: [
          {
            name: 'Geyser Repair',
            description: 'Heating, leakage and thermostat diagnosis for storage geysers',
            media: M.water,
            packages: [
              pkg({
                name: 'Geyser Checkup and Heating Repair',
                sectionTitle: 'Appliance Repair',
                badgeText: 'HOT WATER',
                short: 'Element, thermostat and leak check for wall geysers',
                original: 299,
                discounted: 199,
                duration: '60 mins',
                unit: 'per geyser',
                media: M.water,
                highlights: ['No-heat diagnosis', 'Leak check', 'Spare quote'],
                process: [
                  { title: 'Isolate power', description: 'The geyser is powered down safely.' },
                  { title: 'Test parts', description: 'Element and thermostat continuity are checked.' },
                  { title: 'Quote and fit', description: 'Approved spares are fitted.' },
                  { title: 'Heat test', description: 'A short heating cycle is observed.' },
                ],
                included: ['Diagnosis', 'Minor reseating'],
                need: ['Safe ladder access', 'Power isolation allowed'],
                notes: ['Tank replacement is a separate quote.'],
                faqs: [{ question: 'Instant geysers too?', answer: 'Yes, including instant and storage models.' }],
              }),
            ],
          },
          {
            name: 'Microwave Repair',
            description: 'Heating, turntable and spark diagnosis for solo and convection microwaves',
            media: M.fridge,
            packages: [
              pkg({
                name: 'Microwave Heating Diagnosis',
                sectionTitle: 'Appliance Repair',
                badgeText: 'KITCHEN FIX',
                short: 'No-heat, noise and spark issues checked on site',
                original: 299,
                discounted: 199,
                duration: '45 mins',
                unit: 'per microwave',
                media: M.fridge,
                highlights: ['Safe high-voltage diagnosis', 'Turntable and latch check', 'Spare quote'],
                process: [
                  { title: 'Unplug and inspect', description: 'Cavity, mica and door latch are checked.' },
                  { title: 'Test functions', description: 'Heat, grill or convection modes are verified if safe.' },
                  { title: 'Quote', description: 'Magnetron or board work is priced before opening further.' },
                  { title: 'Repair if stocked', description: 'Common latches and plates can be fitted the same visit.' },
                ],
                included: ['Diagnosis', 'Latch or plate fix if available'],
                need: ['Clear counter space', 'Power point'],
                notes: ['Microwave high-voltage parts are handled only by trained technicians.'],
                faqs: [{ question: 'Is sparking dangerous?', answer: 'Stop using the oven and book diagnosis. Often a worn mica or metal spark is the cause.' }],
              }),
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'Electrician, Plumber & Carpenter',
    slug: 'electrician-plumber-carpenter',
    description: 'Doorstep handy services for electrical fixes, plumbing leaks and carpentry',
    media: M.electric,
    subCategories: [
      {
        name: 'Electrician Services',
        media: M.electric,
        services: [
          {
            name: 'Fan Installation & Repair',
            description: 'Ceiling fan install, replacement, regulator and wobble repair',
            media: M.electric,
            packages: [
              pkg({
                name: 'Ceiling Fan Installation',
                sectionTitle: 'Electrical',
                badgeText: 'HOME BASIC',
                short: 'Mount, balance and regulator hookup for one ceiling fan',
                original: 299,
                discounted: 199,
                duration: '45 mins',
                unit: 'per fan',
                media: M.electric,
                highlights: ['Safe mounting', 'Wobble check', 'Regulator connection'],
                process: [
                  { title: 'Isolate power', description: 'The circuit is switched off at the MCB.' },
                  { title: 'Mount', description: 'Downrod or close-mount is fixed to the hook.' },
                  { title: 'Wire and balance', description: 'Connections are made and blades are balanced.' },
                  { title: 'Test speeds', description: 'All regulator speeds are checked.' },
                ],
                included: ['One fan labour', 'Regulator connection', 'Basic balancing'],
                need: ['Fan at site', 'Working MCB', 'Ladder space'],
                notes: ['New hooks in RCC may need extra civil work.'],
                faqs: [{ question: 'Do you take old fans down?', answer: 'Yes, removal of the old fan is included when replacing.' }],
              }),
            ],
          },
          {
            name: 'Switch & Socket Repair',
            description: 'Switchboard, socket and modular plate repair or replacement',
            media: M.electric,
            packages: [
              pkg({
                name: 'Switch and Socket Replacement',
                sectionTitle: 'Electrical',
                badgeText: 'QUICK FIX',
                short: 'Replace or repair modular switches and power sockets',
                original: 199,
                discounted: 149,
                duration: '30 mins',
                unit: 'per point',
                media: M.electric,
                highlights: ['Sparking socket repair', 'Modular switch change', 'Board retighten'],
                process: [
                  { title: 'Power off', description: 'The right MCB is identified and turned off.' },
                  { title: 'Open board', description: 'Loose or burnt points are inspected.' },
                  { title: 'Replace', description: 'Approved switches or sockets are fitted.' },
                  { title: 'Test load', description: 'The point is tested with a known load.' },
                ],
                included: ['Labour for one point', 'Board screws retightened'],
                need: ['Matching spare if you have a preferred brand', 'MCB access'],
                notes: ['Switch/socket hardware is extra unless you provide it.'],
                faqs: [{ question: 'Can you do a full board?', answer: 'Yes, extra points are billed per point after a quick count.' }],
              }),
            ],
          },
          {
            name: 'MCB & Wiring Repair',
            description: 'Tripping MCB, short-circuit tracing and minor wiring repair',
            media: M.electric,
            packages: [
              pkg({
                name: 'MCB Trip Diagnosis',
                sectionTitle: 'Electrical',
                badgeText: 'SAFETY',
                short: 'Find why an MCB or RCCB keeps tripping and repair the fault',
                original: 399,
                discounted: 249,
                duration: '60 mins',
                unit: 'per visit',
                media: M.electric,
                highlights: ['Trip cause finding', 'Loose-neutral check', 'Safe isolation'],
                process: [
                  { title: 'Map circuits', description: 'Which rooms trip together is identified.' },
                  { title: 'Isolate loads', description: 'Appliances and boards are narrowed down.' },
                  { title: 'Repair', description: 'The short, leakage or weak MCB is corrected.' },
                  { title: 'Prove stable', description: 'The circuit is loaded and watched.' },
                ],
                included: ['Diagnosis', 'Minor wiring repair'],
                need: ['Distribution box access', 'Someone who knows recent changes'],
                notes: ['Full house rewiring is a separate quote.'],
                faqs: [{ question: 'Should I keep resetting the MCB?', answer: 'No. Book diagnosis. Repeated resets can hide a live fault.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Plumbing Services',
        media: M.plumbing,
        services: [
          {
            name: 'Tap & Mixer Repair',
            description: 'Dripping taps, mixers and angle-cock repair or replacement',
            media: M.plumbing,
            packages: [
              pkg({
                name: 'Tap and Mixer Repair',
                sectionTitle: 'Plumbing',
                badgeText: 'LEAK STOP',
                short: 'Washer, cartridge or full tap replacement for one fitting',
                original: 249,
                discounted: 179,
                duration: '40 mins',
                unit: 'per fitting',
                media: M.plumbing,
                highlights: ['Drip diagnosis', 'Cartridge or washer change', 'Leak test'],
                process: [
                  { title: 'Shut water', description: 'The local valve is closed.' },
                  { title: 'Open fitting', description: 'Washer or cartridge is inspected.' },
                  { title: 'Repair or replace', description: 'The part is changed with your approval.' },
                  { title: 'Test', description: 'Hot and cold lines are checked for drip.' },
                ],
                included: ['Labour for one tap/mixer', 'Basic washers if in kit'],
                need: ['Main or local valve access'],
                notes: ['Designer mixers may need brand-specific cartridges.'],
                faqs: [{ question: 'Do you install new mixers I bought?', answer: 'Yes, bring the mixer and accessories; labour is this package.' }],
              }),
            ],
          },
          {
            name: 'Drain Unclogging',
            description: 'Kitchen sink, washbasin and floor-trap blockage clearing',
            media: M.plumbing,
            packages: [
              pkg({
                name: 'Sink and Washbasin Unclogging',
                sectionTitle: 'Plumbing',
                badgeText: 'FLOW BACK',
                short: 'Mechanical clearing of a blocked sink, basin or floor trap',
                original: 399,
                discounted: 299,
                duration: '45 mins',
                unit: 'per point',
                media: M.plumbing,
                highlights: ['Trap open and clear', 'Line snake if needed', 'Flow test'],
                process: [
                  { title: 'Protect the area', description: 'The cabinet or floor is covered.' },
                  { title: 'Open trap', description: 'Hair and grease are removed from the bottle trap.' },
                  { title: 'Rod if needed', description: 'A spring is run through the pipe if the trap was not the only block.' },
                  { title: 'Flush', description: 'Water is run to confirm flow.' },
                ],
                included: ['One blockage point', 'Trap clean'],
                need: ['Under-sink access', 'Bucket'],
                notes: ['Collapsed or fully scaled concealed pipes may need a follow-up.'],
                faqs: [{ question: 'Do you use acid?', answer: 'We prefer mechanical clearing. Harsh acid is avoided on regular traps.' }],
              }),
            ],
          },
          {
            name: 'Toilet Repair',
            description: 'Flush tank, seat and commode leak or fill issues',
            media: M.plumbing,
            packages: [
              pkg({
                name: 'Flush Tank and Commode Repair',
                sectionTitle: 'Plumbing',
                badgeText: 'BATH FIX',
                short: 'Running flush, weak flush or seat repair for one toilet',
                original: 349,
                discounted: 249,
                duration: '45 mins',
                unit: 'per toilet',
                media: M.plumbing,
                highlights: ['Fill-valve and flapper check', 'Seat hinge repair', 'Leak test'],
                process: [
                  { title: 'Open cistern', description: 'The tank internals are inspected.' },
                  { title: 'Replace internals', description: 'Fill or flush valves are changed if needed.' },
                  { title: 'Seat and base', description: 'Loose seats or visible base seepage are checked.' },
                  { title: 'Test flush', description: 'Several flushes confirm a quiet fill.' },
                ],
                included: ['Labour', 'Minor kit internals if compatible'],
                need: ['Water supply to the tank'],
                notes: ['Concealed cistern brands may need specific spares.'],
                faqs: [{ question: 'Can you replace the full commode?', answer: 'Yes as a separate civil-assist job after a site look.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Carpenter Services',
        media: M.carpenter,
        services: [
          {
            name: 'Furniture Assembly',
            description: 'Flat-pack beds, tables, wardrobes and study units assembled on site',
            media: M.carpenter,
            packages: [
              pkg({
                name: 'Furniture Assembly Visit',
                sectionTitle: 'Carpentry',
                badgeText: 'FLAT PACK',
                short: 'Assemble one standard furniture unit from boxed parts',
                original: 699,
                discounted: 499,
                duration: '90 mins',
                unit: 'per unit',
                media: M.carpenter,
                highlights: ['Follows brand instructions', 'Hardware check', 'Level and tighten'],
                process: [
                  { title: 'Unpack and sort', description: 'Panels and hardware are laid out.' },
                  { title: 'Build carcass', description: 'The frame is assembled square.' },
                  { title: 'Fit doors and drawers', description: 'Alignment and soft-close are set.' },
                  { title: 'Level', description: 'Feet and wall straps are set if provided.' },
                ],
                included: ['One standard unit', 'Basic wall strap if in the box'],
                need: ['All parts present', 'Clear floor space'],
                notes: ['Large sliding wardrobes may need extra hours.'],
                faqs: [{ question: 'Amazon or IKEA units?', answer: 'Yes, as long as the hardware packet is complete.' }],
              }),
            ],
          },
          {
            name: 'Drill & Hang',
            description: 'TV, shelves, mirrors and photo frames drilled and mounted',
            media: M.carpenter,
            packages: [
              pkg({
                name: 'TV, Shelf or Mirror Mount',
                sectionTitle: 'Carpentry',
                badgeText: 'WALL MOUNT',
                short: 'Drill and hang one TV, shelf or heavy mirror with correct wall plugs',
                original: 399,
                discounted: 299,
                duration: '60 mins',
                unit: 'per item',
                media: M.carpenter,
                highlights: ['Stud or masonry check', 'Level mount', 'Cable tidy for TVs'],
                process: [
                  { title: 'Mark height', description: 'Viewing height or shelf line is agreed.' },
                  { title: 'Check wall', description: 'Brick, AAC or stud is identified for the right plug.' },
                  { title: 'Drill and hang', description: 'Anchors are set and the item is mounted level.' },
                  { title: 'Load test', description: 'A gentle load check is done before handover.' },
                ],
                included: ['One mount labour', 'Standard wall plugs'],
                need: ['Bracket with the TV or shelf', 'Power for the drill'],
                notes: ['Concealed pipe scanning is visual plus caution; share plumbing layouts if known.'],
                faqs: [{ question: 'Do you bring the TV bracket?', answer: 'Brackets are extra unless you already have one.' }],
              }),
            ],
          },
          {
            name: 'Door & Cabinet Repair',
            description: 'Door alignment, lock strike, hinges and kitchen shutter repair',
            media: M.carpenter,
            packages: [
              pkg({
                name: 'Door Hinge and Cabinet Repair',
                sectionTitle: 'Carpentry',
                badgeText: 'ALIGN',
                short: 'Fix sagging doors, loose hinges and kitchen shutter alignment',
                original: 449,
                discounted: 329,
                duration: '60 mins',
                unit: 'per visit',
                media: M.carpenter,
                highlights: ['Hinge reset', 'Lock strike alignment', 'Shutter screws and buffers'],
                process: [
                  { title: 'Diagnose sag', description: 'Hinge screws, frame and shutter are checked.' },
                  { title: 'Reinforce', description: 'Longer screws or hinge shift as needed.' },
                  { title: 'Align lock', description: 'The strike plate is moved so the latch seats.' },
                  { title: 'Test', description: 'Open-close and lock are checked several times.' },
                ],
                included: ['Labour for one door or two shutters', 'Basic screws'],
                need: ['The room accessible', 'Replacement hinges if broken'],
                notes: ['Fully termite-eaten frames need replacement, not repair.'],
                faqs: [{ question: 'Kitchen soft-close too?', answer: 'Yes, if the damper is available or already on the shutter.' }],
              }),
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'Salon for Women',
    slug: 'salon-for-women',
    description: 'Hygienic at-home salon: waxing, facials, manicure, pedicure and hair care',
    media: M.women,
    subCategories: [
      {
        name: 'Waxing & Hair Removal',
        media: M.women,
        services: [
          {
            name: 'Honey Waxing',
            description: 'Warm honey wax with disposable strips and post-wax soothe',
            media: M.women,
            packages: [
              pkg({
                name: 'Honey Wax Full Arms + Full Legs + Underarms',
                sectionTitle: 'Waxing',
                badgeText: 'BESTSELLER',
                short: 'Smooth honey wax combo with post-wax aloe finish',
                original: 899,
                discounted: 599,
                duration: '45 mins',
                unit: 'per session',
                media: M.women,
                highlights: ['Single-use strips and spatulas', 'Temperature-controlled wax', 'Post-wax soothe'],
                process: [
                  { title: 'Cleanse', description: 'Oil and sweat are wiped so wax can grip hair.' },
                  { title: 'Apply and strip', description: 'Warm honey wax is applied in the hair direction and removed quickly.' },
                  { title: 'Check patches', description: 'Missed strips are touched up.' },
                  { title: 'Soothe', description: 'Aloe or calamine finish reduces redness.' },
                ],
                included: ['Full arms', 'Full legs', 'Underarms', 'Post-wax gel'],
                need: ['Power for the wax heater', 'A private room'],
                notes: ['Hair should be at least 3 to 5 mm for a clean pull.'],
                faqs: [{ question: 'Are spatulas reused?', answer: 'No. Fresh spatulas and strips are opened for you.' }],
              }),
            ],
          },
          {
            name: 'Rica Waxing',
            description: 'Low-heat liposoluble wax for sensitive skin',
            media: M.women,
            packages: [
              pkg({
                name: 'Rica Wax Full Arms + Underarms',
                sectionTitle: 'Waxing',
                badgeText: 'SENSITIVE SKIN',
                short: 'Low-heat cream wax for a closer finish on arms and underarms',
                original: 999,
                discounted: 749,
                duration: '40 mins',
                unit: 'per session',
                media: M.women,
                highlights: ['Lower temperature wax', 'Cleaner finish on coarse hair', 'Disposable kit'],
                process: [
                  { title: 'Patch feel', description: 'A small test checks skin comfort.' },
                  { title: 'Apply cream wax', description: 'Thin layers are used for a closer pull.' },
                  { title: 'Finish edges', description: 'Bikini-line adjacent areas are skipped unless booked.' },
                  { title: 'Calming oil', description: 'Residue is wiped and skin is soothed.' },
                ],
                included: ['Full arms', 'Underarms', 'Post-wax care'],
                need: ['Private space', 'Power'],
                notes: ['Avoid sun and exfoliation for 24 hours.'],
                faqs: [{ question: 'Is Rica better for sensitive skin?', answer: 'Many clients prefer it because it is used at a lower temperature.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Facials & Cleanups',
        media: M.facial,
        services: [
          {
            name: 'Cleanup & Detan',
            description: 'Blackhead cleanup and detan pack for face and neck',
            media: M.facial,
            packages: [
              pkg({
                name: 'Classic Cleanup and Detan',
                sectionTitle: 'Skin',
                badgeText: 'FRESH FACE',
                short: 'Steam, extraction and detan pack for dull city skin',
                original: 1299,
                discounted: 899,
                duration: '60 mins',
                unit: 'per session',
                media: M.facial,
                highlights: ['Steam and extraction', 'Detan pack', 'Neck included'],
                process: [
                  { title: 'Cleanse', description: 'Makeup and pollution film are removed.' },
                  { title: 'Steam and extract', description: 'Clogged pores are gently cleared.' },
                  { title: 'Detan pack', description: 'A cooling pack is applied on face and neck.' },
                  { title: 'Moisturise', description: 'Sunscreen advice is given if you are heading out.' },
                ],
                included: ['Cleanup', 'Detan pack', 'Neck'],
                need: ['A chair or bed', 'A towel you can spare'],
                notes: ['Avoid peak sun for a few hours after extraction.'],
                faqs: [{ question: 'Will I be red after?', answer: 'Mild redness can last an hour after extraction and then settles.' }],
              }),
            ],
          },
          {
            name: 'Brightening Facial',
            description: 'Sealed-kit brightening facial with massage and mask',
            media: M.facial,
            packages: [
              pkg({
                name: 'Brightening Glow Facial',
                sectionTitle: 'Luxury Facials',
                badgeText: 'INSTANT GLOW',
                short: 'Sealed professional kit with cleanse, massage, mask and glow finish',
                original: 2199,
                discounted: 1699,
                duration: '75 mins',
                unit: 'per session',
                media: M.facial,
                highlights: ['Kit opened in front of you', 'Face, neck and shoulder massage', 'Leave-on glow finish'],
                process: [
                  { title: 'Cleanse and steam', description: 'Pores are prepped without over-stripping.' },
                  { title: 'Treat', description: 'Serum and massage improve product uptake.' },
                  { title: 'Mask', description: 'A kit mask is timed as directed.' },
                  { title: 'Finish', description: 'Moisturiser and sunscreen layer complete the service.' },
                ],
                included: ['Full kit facial', 'Neck and shoulder massage', 'Cleanup as needed'],
                need: ['Reclining chair or bed'],
                notes: ['Not a medical peel. Share if you are on strong dermatology actives.'],
                faqs: [{ question: 'Sensitive skin OK?', answer: 'Tell the beautician. The kit can skip fragrance-heavy steps if needed.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Manicure & Pedicure',
        media: M.nails,
        services: [
          {
            name: 'Pedicure',
            description: 'Soak, scrub, nail shape and foot massage',
            media: M.nails,
            packages: [
              pkg({
                name: 'Classic Spa Pedicure',
                sectionTitle: 'Nail & Foot Care',
                badgeText: 'RELAX',
                short: 'Warm soak, heel scrub, nail shaping and foot massage',
                original: 799,
                discounted: 549,
                duration: '45 mins',
                unit: 'per session',
                media: M.nails,
                highlights: ['Fresh tub liner', 'Callus scrub', 'Nail cut and file'],
                process: [
                  { title: 'Soak', description: 'Warm water softens heels and cuticles.' },
                  { title: 'Scrub and shape', description: 'Dead skin is reduced and nails are shaped.' },
                  { title: 'Massage', description: 'Foot and lower-leg massage with lotion.' },
                  { title: 'Polish optional', description: 'Regular polish is applied if you want it.' },
                ],
                included: ['Soak', 'Scrub', 'Nail care', 'Massage'],
                need: ['A chair', 'Water nearby'],
                notes: ['Gel polish is not included unless booked as an add-on.'],
                faqs: [{ question: 'Are tools sterilised?', answer: 'Metal tools are sanitised and liners are single-use.' }],
              }),
            ],
          },
          {
            name: 'Manicure',
            description: 'Nail shape, cuticle care and hand massage',
            media: M.nails,
            packages: [
              pkg({
                name: 'Classic Manicure',
                sectionTitle: 'Nail & Foot Care',
                badgeText: 'HAND CARE',
                short: 'Shape, cuticle tidy, soak and hand massage',
                original: 599,
                discounted: 399,
                duration: '35 mins',
                unit: 'per session',
                media: M.nails,
                highlights: ['Nail shaping', 'Cuticle care', 'Hand massage'],
                process: [
                  { title: 'Remove old polish', description: 'Previous colour is taken off gently.' },
                  { title: 'Shape and soak', description: 'Nails are filed and cuticles are softened.' },
                  { title: 'Massage', description: 'Hands and forearms are massaged.' },
                  { title: 'Polish', description: 'Regular polish is applied on request.' },
                ],
                included: ['Nail shape', 'Cuticle care', 'Hand massage'],
                need: ['A table or stable surface'],
                notes: ['Nail art is extra.'],
                faqs: [{ question: 'Can I keep my current length?', answer: 'Yes, we only trim if you ask.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Hair Care',
        media: M.hair,
        services: [
          {
            name: 'Hair Spa',
            description: 'Oil massage, steam and mask for dry or chemically treated hair',
            media: M.hair,
            packages: [
              pkg({
                name: 'Nourishing Hair Spa',
                sectionTitle: 'Hair',
                badgeText: 'REPAIR',
                short: 'Scalp massage, steam and mask for frizz and dryness',
                original: 1499,
                discounted: 1099,
                duration: '60 mins',
                unit: 'per session',
                media: M.hair,
                highlights: ['Scalp massage', 'Hair mask', 'Blow-dry finish optional'],
                process: [
                  { title: 'Consult', description: 'Hair type and recent colour are noted.' },
                  { title: 'Massage', description: 'Oil or serum is massaged into the scalp.' },
                  { title: 'Mask and steam', description: 'A mask is applied and gently steamed.' },
                  { title: 'Rinse and finish', description: 'Hair is washed and lightly finished.' },
                ],
                included: ['Spa ritual', 'Mask', 'Basic blow-dry'],
                need: ['Wash area or bathroom access', 'Power for dryer'],
                notes: ['A full haircut is a separate service.'],
                faqs: [{ question: 'Colour-treated hair OK?', answer: 'Yes. We use colour-safe products unless you prefer oil only.' }],
              }),
            ],
          },
          {
            name: 'Women Haircut & Blow Dry',
            description: 'Trim or restyle with wash and blow dry',
            media: M.hair,
            packages: [
              pkg({
                name: 'Haircut and Blow Dry',
                sectionTitle: 'Hair',
                badgeText: 'STYLE',
                short: 'Consultation, cut and blow-dry finish at home',
                original: 899,
                discounted: 649,
                duration: '50 mins',
                unit: 'per person',
                media: M.hair,
                highlights: ['Face-shape consult', 'Precision cut', 'Blow dry'],
                process: [
                  { title: 'Consult', description: 'Length and layers are agreed in a mirror.' },
                  { title: 'Wash', description: 'Hair is washed if water access is available.' },
                  { title: 'Cut', description: 'Wet or dry cut as suited to the style.' },
                  { title: 'Blow dry', description: 'A smooth finish is given.' },
                ],
                included: ['Haircut', 'Blow dry'],
                need: ['Chair, mirror and power', 'Bathroom for wash'],
                notes: ['Keratin or colour is not included.'],
                faqs: [{ question: 'Do you cut curly hair dry?', answer: 'We follow the method that suits your texture after a quick consult.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Threading & Face Wax',
        media: M.women,
        services: [
          {
            name: 'Eyebrow Threading',
            description: 'Eyebrow shaping with optional upper-lip threading',
            media: M.women,
            packages: [
              pkg({
                name: 'Eyebrow and Upper Lip Threading',
                sectionTitle: 'Face',
                badgeText: 'QUICK',
                short: 'Shape brows and tidy upper lip with fresh thread',
                original: 149,
                discounted: 99,
                duration: '15 mins',
                unit: 'per person',
                media: M.women,
                highlights: ['Fresh thread', 'Shape consult', 'Upper lip included'],
                process: [
                  { title: 'Map the brow', description: 'Preferred arch is confirmed.' },
                  { title: 'Thread', description: 'Stray hair is removed with fresh thread.' },
                  { title: 'Lip tidy', description: 'Upper lip is finished if booked.' },
                  { title: 'Soothe', description: 'A light calamine or aloe is applied.' },
                ],
                included: ['Eyebrows', 'Upper lip'],
                need: ['Good light and a chair'],
                notes: ['Chin or forehead is extra.'],
                faqs: [{ question: 'Threading or wax for brows?', answer: 'Threading is more precise for shape; wax is better for larger areas.' }],
              }),
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Men's Salon & Grooming",
    slug: 'mens-salon-grooming',
    description: 'At-home haircut, beard, detan and relaxing massage for men',
    media: M.men,
    subCategories: [
      {
        name: 'Haircut & Beard Care',
        media: M.men,
        services: [
          {
            name: "Men's Haircut",
            description: 'Clipper and scissor cut with neck clean-up',
            media: M.men,
            packages: [
              pkg({
                name: "Men's Haircut and Head Massage",
                sectionTitle: 'Hair Styling',
                badgeText: 'POPULAR',
                short: 'Custom haircut plus a short relaxing scalp massage',
                original: 399,
                discounted: 249,
                duration: '40 mins',
                unit: 'per person',
                media: M.men,
                highlights: ['Sanitised clippers', 'Single-use cape', 'Floor clean-up'],
                process: [
                  { title: 'Consult', description: 'Length on top, sides and neckline is agreed.' },
                  { title: 'Cut', description: 'Clippers and scissors are used as per the style.' },
                  { title: 'Massage', description: 'A short scalp massage is included.' },
                  { title: 'Clean', description: 'Hair is swept and the cape is packed.' },
                ],
                included: ['Haircut', 'Neck finish', '10 min scalp massage', 'Floor clean-up'],
                need: ['Chair, power and a mirror'],
                notes: ['Hair wash is not included unless water access is arranged.'],
                faqs: [{ question: 'Will hair be left on the floor?', answer: 'A mat is used and hair is swept before we leave.' }],
              }),
            ],
          },
          {
            name: 'Beard Styling',
            description: 'Beard trim, cheek line and hot-towel finish',
            media: M.men,
            packages: [
              pkg({
                name: 'Beard Trim and Hot Towel',
                sectionTitle: 'Beard Grooming',
                badgeText: 'SHARP LOOK',
                short: 'Precision trim, cheek line and hot-towel comfort',
                original: 299,
                discounted: 179,
                duration: '25 mins',
                unit: 'per person',
                media: M.men,
                highlights: ['Fresh blade if shave is requested', 'Cheek and neck line', 'Beard oil finish'],
                process: [
                  { title: 'Comb and agree shape', description: 'Length and line are confirmed.' },
                  { title: 'Trim', description: 'Clippers set the bulk; scissors tidy the moustache.' },
                  { title: 'Hot towel', description: 'A warm towel settles the skin.' },
                  { title: 'Finish', description: 'Oil or balm is applied.' },
                ],
                included: ['Beard trim', 'Hot towel', 'Finish product'],
                need: ['Chair and mirror'],
                notes: ['Full face shave uses a new blade opened in front of you.'],
                faqs: [{ question: 'Is the blade new?', answer: 'Yes whenever a razor is used.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Facial & Detan',
        media: M.facial,
        services: [
          {
            name: "Men's Detan",
            description: 'Cleanup and detan pack designed for mens skin',
            media: M.facial,
            packages: [
              pkg({
                name: "Men's Cleanup and Detan",
                sectionTitle: 'Skin',
                badgeText: 'FRESH',
                short: 'Blackhead cleanup plus detan for face, neck and under-beard area',
                original: 999,
                discounted: 749,
                duration: '50 mins',
                unit: 'per session',
                media: M.facial,
                highlights: ['Beard-friendly cleanup', 'Detan pack', 'Neck included'],
                process: [
                  { title: 'Cleanse', description: 'Sweat and sunscreen film are removed.' },
                  { title: 'Steam and extract', description: 'T-zone congestion is cleared gently.' },
                  { title: 'Detan', description: 'Pack sits on face and neck.' },
                  { title: 'Moisturise', description: 'A light, non-greasy finish is applied.' },
                ],
                included: ['Cleanup', 'Detan', 'Neck'],
                need: ['Chair and a towel'],
                notes: ['Skip a close shave immediately after extraction if skin is reactive.'],
                faqs: [{ question: 'Can I do this with a beard?', answer: 'Yes. Product is kept off dense beard hair except edges.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Relaxing Head & Body Massage',
        media: M.massage,
        services: [
          {
            name: 'Head & Shoulder Massage',
            description: 'Oil massage for scalp, neck and shoulders',
            media: M.massage,
            packages: [
              pkg({
                name: 'Head, Neck and Shoulder Massage',
                sectionTitle: 'Massage Therapy',
                badgeText: 'DESTRESS',
                short: 'Warm herbal oil massage for desk-neck stiffness',
                original: 599,
                discounted: 399,
                duration: '30 mins',
                unit: 'per session',
                media: M.massage,
                highlights: ['Scalp acupressure', 'Neck release', 'Shoulder kneading'],
                process: [
                  { title: 'Oil warm-up', description: 'Oil is warmed and applied to scalp and neck.' },
                  { title: 'Scalp work', description: 'Pressure points on the head are worked.' },
                  { title: 'Neck and traps', description: 'Cervical and shoulder knots are released.' },
                  { title: 'Wipe down', description: 'Excess oil is towelled off.' },
                ],
                included: ['30 min massage', 'Oil'],
                need: ['Sturdy chair', 'An old T-shirt you can oil'],
                notes: ['This is a therapeutic wellness massage.'],
                faqs: [{ question: 'Will it help headaches?', answer: 'Tension headaches from neck tightness often ease after the session.' }],
              }),
            ],
          },
          {
            name: 'Full Body Massage',
            description: 'Male therapist full-body oil massage at home',
            media: M.massage,
            packages: [
              pkg({
                name: 'Full Body Oil Massage',
                sectionTitle: 'Massage Therapy',
                badgeText: '60 MIN',
                short: 'Full-body oil massage focused on back, legs and shoulders',
                original: 1799,
                discounted: 1299,
                duration: '60 mins',
                unit: 'per session',
                media: M.massage,
                highlights: ['Male therapist', 'Full body coverage', 'Oil of your comfort'],
                process: [
                  { title: 'Consult pressure', description: 'Light, medium or firm pressure is set.' },
                  { title: 'Back and legs', description: 'Long strokes reduce stiffness.' },
                  { title: 'Shoulders and arms', description: 'Desk tension is worked out.' },
                  { title: 'Rest', description: 'A few minutes to sit up slowly before we pack.' },
                ],
                included: ['60 min massage', 'Towels if you do not have extras'],
                need: ['A bed or thick mat', 'Private room'],
                notes: ['Strictly therapeutic. Please share injuries before we start.'],
                faqs: [{ question: 'Do I need a massage table?', answer: 'A bed with a towel layer is enough.' }],
              }),
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'Painting & Waterproofing',
    slug: 'painting-waterproofing',
    description: 'Putty, primer, emulsion painting and damp-proof waterproofing',
    media: M.paint,
    subCategories: [
      {
        name: 'Home Painting Services',
        media: M.paint,
        services: [
          {
            name: 'Single Room Painting',
            description: 'Putty touch-ups, primer and emulsion for one room or accent wall',
            media: M.paint,
            packages: [
              pkg({
                name: '1 Room / Accent Wall Painting',
                sectionTitle: 'Painting',
                badgeText: 'REFRESH',
                short: 'Surface prep, primer and two coats on one room or accent wall',
                original: 4499,
                discounted: 3499,
                duration: '1 day',
                unit: 'per room',
                media: M.paint,
                highlights: ['Furniture shifting in-room', 'Putty on cracks', 'Two emulsion coats'],
                process: [
                  { title: 'Site measure', description: 'Wall area and colour are confirmed.' },
                  { title: 'Prep', description: 'Fills, sanding and masking are done.' },
                  { title: 'Prime and paint', description: 'Primer plus two coats are applied.' },
                  { title: 'Clean', description: 'Tape is pulled and the room is swept.' },
                ],
                included: ['Labour', 'Standard masking', 'Putty on minor cracks'],
                need: ['Empty or easy-to-shift furniture', 'Water for wash-up'],
                notes: ['Paint material brand and colour are confirmed in the site visit if not already chosen.'],
                faqs: [{ question: 'Do you bring the paint?', answer: 'Material can be included or you can supply a brand you prefer. We confirm before starting.' }],
              }),
            ],
          },
          {
            name: 'Full Home Painting',
            description: 'Interior painting plan for a full apartment',
            media: M.paint,
            packages: [
              pkg({
                name: 'Full Home Interior Painting Visit',
                sectionTitle: 'Painting',
                badgeText: 'WHOLE HOME',
                short: 'On-site measurement and interior painting plan for the full home',
                original: 1999,
                discounted: 999,
                duration: '90 mins',
                unit: 'per visit',
                media: M.paint,
                highlights: ['Room-wise measurement', 'Finish options', 'Written estimate'],
                process: [
                  { title: 'Walk the home', description: 'Every room, ceiling and woodwork need is noted.' },
                  { title: 'Check substrate', description: 'Damp, flaking and seepage are flagged.' },
                  { title: 'Share finishes', description: 'Emulsion, satin and putty levels are explained.' },
                  { title: 'Estimate', description: 'A room-wise quote is sent after the visit.' },
                ],
                included: ['Site visit', 'Measurement', 'Estimate'],
                need: ['Access to all rooms'],
                notes: ['Waterproofing is quoted separately if damp is found.'],
                faqs: [{ question: 'Is the visit charge adjusted later?', answer: 'Yes, the visit fee is adjusted in the painting invoice if you proceed.' }],
              }),
            ],
          },
        ],
      },
      {
        name: 'Waterproofing & Damp Repair',
        media: M.waterproof,
        services: [
          {
            name: 'Bathroom Waterproofing',
            description: 'Bath floor and wall damp treatment before tile or coating work',
            media: M.waterproof,
            packages: [
              pkg({
                name: 'Bathroom Damp and Leak Treatment',
                sectionTitle: 'Waterproofing',
                badgeText: 'DAMP STOP',
                short: 'Inspect seepage and apply a chemical barrier on the affected bath zone',
                original: 3499,
                discounted: 2499,
                duration: '4 hrs',
                unit: 'per bathroom',
                media: M.waterproof,
                highlights: ['Source check', 'Chemical coat', 'Cure guidance'],
                process: [
                  { title: 'Inspect', description: 'Ceiling below, joints and floor traps are checked.' },
                  { title: 'Prep', description: 'Loose material is opened where required.' },
                  { title: 'Coat', description: 'Waterproofing chemical is applied in coats.' },
                  { title: 'Cure', description: 'Drying and tile/putty next steps are explained.' },
                ],
                included: ['Inspection', 'Treatment of the marked zone'],
                need: ['Dry access', 'Furniture moved from the room below if ceiling work'],
                notes: ['Tile removal, if needed, is quoted after inspection.'],
                faqs: [{ question: 'Will the downstairs leak stop immediately?', answer: 'Coats need curing time. We share a realistic window after seeing the damage.' }],
              }),
            ],
          },
          {
            name: 'Wall Seepage Repair',
            description: 'Crack injection and damp wall treatment for interior seepage',
            media: M.waterproof,
            packages: [
              pkg({
                name: 'Wall Seepage and Crack Injection',
                sectionTitle: 'Waterproofing',
                badgeText: 'WALL FIX',
                short: 'Crack filling and damp-seal treatment for interior seepage patches',
                original: 2499,
                discounted: 1799,
                duration: '3 hrs',
                unit: 'per wall zone',
                media: M.waterproof,
                highlights: ['Crack chase and fill', 'Damp seal', 'Putty-ready surface'],
                process: [
                  { title: 'Map damp', description: 'The wet patch and likely source are marked.' },
                  { title: 'Open cracks', description: 'Hairline cracks are opened for a proper fill.' },
                  { title: 'Inject / coat', description: 'Sealant and damp-proof coat are applied.' },
                  { title: 'Level', description: 'The patch is left ready for paint after curing.' },
                ],
                included: ['One wall zone', 'Crack fill', 'Damp coat'],
                need: ['Furniture pulled away from the wall'],
                notes: ['External plumbing leaks must be fixed or the damp can return.'],
                faqs: [{ question: 'Can you paint the same day?', answer: 'Usually no. Waterproof coats need cure time before emulsion.' }],
              }),
            ],
          },
        ],
      },
    ],
  },
];

function assertUniqueServiceNames(catalog: CatInput[]) {
  const seen = new Map<string, string>();
  for (const cat of catalog) {
    for (const sub of cat.subCategories) {
      for (const service of sub.services) {
        const key = norm(service.name);
        if (seen.has(key)) {
          throw new Error(`Duplicate service name "${service.name}" (also in ${seen.get(key)})`);
        }
        seen.set(key, `${cat.name} / ${sub.name}`);
      }
    }
  }
}

async function remapHomeLayout(idMap: Map<string, string>) {
  if (idMap.size === 0) return;
  const setting = await prisma.platformSetting.findUnique({ where: { key: 'HOME_LAYOUT' } });
  if (!setting?.value || typeof setting.value !== 'object') return;
  const value = { ...(setting.value as Record<string, unknown>) };
  let changed = false;

  const remapIds = (ids: unknown): string[] | unknown => {
    if (!Array.isArray(ids)) return ids;
    const next = ids.map((id) => (typeof id === 'string' && idMap.get(id) ? idMap.get(id)! : id));
    const unique = [...new Set(next.filter((id) => typeof id === 'string'))] as string[];
    if (JSON.stringify(unique) !== JSON.stringify(ids)) changed = true;
    return unique;
  };

  if (Array.isArray(value.popularServiceIds)) {
    value.popularServiceIds = remapIds(value.popularServiceIds);
  }
  if (Array.isArray(value.serviceSections)) {
    value.serviceSections = (value.serviceSections as any[]).map((section) => ({
      ...section,
      serviceIds: remapIds(section.serviceIds),
    }));
  }
  if (changed) {
    await prisma.platformSetting.update({
      where: { key: 'HOME_LAYOUT' },
      data: { value },
    });
    console.log('  Remapped home layout service IDs onto kept services');
  }
}

async function archiveDuplicateServices(): Promise<Map<string, string>> {
  console.log('\n--- Archiving duplicate services ---');
  const services = await prisma.service.findMany({
    where: { isActive: true },
    include: { _count: { select: { packages: true, bookings: true, reviews: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const groups = new Map<string, typeof services>();
  for (const service of services) {
    const key = norm(service.name);
    const list = groups.get(key) || [];
    list.push(service);
    groups.set(key, list);
  }

  const idMap = new Map<string, string>();
  let archived = 0;

  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => {
      const score = (row: (typeof group)[number]) =>
        row._count.packages * 10 + row._count.bookings * 5 + row._count.reviews;
      return score(b) - score(a) || a.createdAt.getTime() - b.createdAt.getTime();
    });
    const keeper = ranked[0];
    const extras = ranked.slice(1);
    console.log(`  Keep "${keeper.name}" (${keeper.id}); archive ${extras.length} extra copy/copies`);

    for (const extra of extras) {
      const extraPackages = await prisma.servicePackage.findMany({ where: { serviceId: extra.id } });
      for (const extraPkg of extraPackages) {
        const exists = await prisma.servicePackage.findFirst({
          where: { serviceId: keeper.id, name: extraPkg.name || extraPkg.title || '' },
        });
        if (exists) {
          await prisma.booking.updateMany({
            where: { packageId: extraPkg.id },
            data: { packageId: exists.id, serviceId: keeper.id },
          });
          await prisma.servicePackage.update({
            where: { id: extraPkg.id },
            data: { isActive: false },
          });
        } else {
          await prisma.servicePackage.update({
            where: { id: extraPkg.id },
            data: { serviceId: keeper.id },
          });
        }
      }

      await prisma.booking.updateMany({ where: { serviceId: extra.id }, data: { serviceId: keeper.id } });
      await prisma.review.updateMany({ where: { serviceId: extra.id }, data: { serviceId: keeper.id } });

      const vendorLinks = await prisma.vendorService.findMany({ where: { serviceId: extra.id } });
      for (const link of vendorLinks) {
        const already = await prisma.vendorService.findFirst({
          where: { vendorId: link.vendorId, serviceId: keeper.id },
        });
        if (already) {
          await prisma.vendorService.delete({ where: { id: link.id } });
        } else {
          await prisma.vendorService.update({
            where: { id: link.id },
            data: { serviceId: keeper.id },
          });
        }
      }

      await prisma.service.update({
        where: { id: extra.id },
        data: {
          isActive: false,
          deletedAt: new Date(),
          slug: `${extra.slug}-dup-${extra.id.slice(0, 6)}`.slice(0, 80),
        },
      });
      idMap.set(extra.id, keeper.id);
      archived += 1;
    }
    void name;
  }

  await remapHomeLayout(idMap);
  console.log(`  Archived ${archived} duplicate service(s)`);
  return idMap;
}

async function mergeDuplicateSubcategories() {
  console.log('\n--- Merging duplicate sub-categories ---');
  const subs = await prisma.serviceSubCategory.findMany({ orderBy: { createdAt: 'asc' } });
  const groups = new Map<string, typeof subs>();
  for (const sub of subs) {
    const key = `${sub.categoryId}::${norm(sub.name)}`;
    const list = groups.get(key) || [];
    list.push(sub);
    groups.set(key, list);
  }

  let merged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = group[0];
    for (const extra of group.slice(1)) {
      await prisma.service.updateMany({
        where: { subCategoryId: extra.id },
        data: { subCategoryId: keeper.id },
      });
      await prisma.serviceSubCategory.delete({ where: { id: extra.id } }).catch(() => undefined);
      merged += 1;
    }
  }
  console.log(`  Merged ${merged} duplicate sub-category row(s)`);
}

async function upsertCatalog() {
  console.log('\n--- Upserting unique catalog into MongoDB ---');
  let catCount = 0;
  let subCount = 0;
  let serviceCount = 0;
  let packageCount = 0;

  for (let catIdx = 0; catIdx < CATALOG.length; catIdx++) {
    const catData = CATALOG[catIdx];
    const catIcon = await hostImage(catData.media.icon, 'servfex/categories');
    const category = await prisma.serviceCategory.upsert({
      where: { slug: catData.slug },
      update: {
        name: catData.name,
        description: catData.description,
        iconUrl: catIcon,
        displayOrder: catIdx + 1,
        isActive: true,
      },
      create: {
        name: catData.name,
        slug: catData.slug,
        description: catData.description,
        iconUrl: catIcon,
        displayOrder: catIdx + 1,
        isActive: true,
      },
    });
    catCount += 1;
    console.log(`\nCategory: ${category.name}`);

    for (let subIdx = 0; subIdx < catData.subCategories.length; subIdx++) {
      const subData = catData.subCategories[subIdx];
      const subIcon = await hostImage(subData.media.icon, 'servfex/sub-categories');
      const subBanners = await hostList(subData.media.banners, 'servfex/sub-categories/banners');

      let subCat = await prisma.serviceSubCategory.findFirst({
        where: { categoryId: category.id, name: subData.name },
      });
      const subPayload = {
        categoryId: category.id,
        name: subData.name,
        iconUrl: subIcon,
        bannerImages: subBanners,
        displayOrder: subIdx,
        isActive: true,
      };
      subCat = subCat
        ? await prisma.serviceSubCategory.update({ where: { id: subCat.id }, data: subPayload })
        : await prisma.serviceSubCategory.create({ data: subPayload });
      subCount += 1;

      for (let svcIdx = 0; svcIdx < subData.services.length; svcIdx++) {
        const svcData = subData.services[svcIdx];
        const stableSlug = slugify(svcData.name);
        const svcIcon = await hostImage(svcData.media.icon, 'servfex/services/icons');
        const svcBanners = await hostList(svcData.media.banners.slice(0, 3), 'servfex/services/banners');
        const starting = Number.parseFloat(svcData.packages[0]?.discountedPrice || '499') || 499;
        const duration = svcData.packages[0]?.duration ?? '60 mins';

        let service =
          (await prisma.service.findFirst({ where: { slug: stableSlug, isActive: true } })) ||
          (await prisma.service.findFirst({
            where: { name: svcData.name, isActive: true },
          }));

        const servicePayload = {
          categoryId: category.id,
          subCategoryId: subCat.id,
          name: svcData.name,
          description: svcData.description,
          iconUrl: svcIcon,
          imageUrl: svcBanners[0] || svcIcon,
          bannerImages: svcBanners,
          startingPrice: rupee(starting),
          priceUnit: svcData.packages[0]?.unit || 'per service',
          durationText: duration,
          isPopular: svcIdx === 0 && subIdx === 0,
          isActive: true,
        };

        if (service) {
          service = await prisma.service.update({
            where: { id: service.id },
            data: servicePayload,
          });
        } else {
          const slugTaken = await prisma.service.findFirst({ where: { slug: stableSlug } });
          service = await prisma.service.create({
            data: {
              ...servicePayload,
              slug: slugTaken ? `${stableSlug}-${category.slug}` : stableSlug,
              rating: 4.82,
              reviewCount: 48 + svcIdx * 7,
            },
          });
        }
        serviceCount += 1;
        console.log(`  Service: ${service.name}`);

        for (let pIdx = 0; pIdx < svcData.packages.length; pIdx++) {
          const p = svcData.packages[pIdx];
          const cardImage = await hostImage(p.media.banners[0] || p.media.icon, 'servfex/packages/cards');
          const detailBanners = await hostList(p.media.banners, 'servfex/packages/banners');
          const processSteps = [];
          for (let sIdx = 0; sIdx < p.process.length; sIdx++) {
            const step = p.process[sIdx];
            processSteps.push({
              stepNumber: sIdx + 1,
              title: step.title,
              description: step.description,
              imageUrl: await hostImage(p.media.steps[sIdx % p.media.steps.length], 'servfex/packages/steps'),
            });
          }

          const packagePayload = {
            name: p.name,
            title: p.name,
            description: p.shortDescription,
            shortDescription: p.shortDescription,
            badgeText: p.badgeText,
            sectionTitle: p.sectionTitle,
            originalPrice: p.originalPrice,
            discountedPrice: p.discountedPrice,
            price: p.discountedPrice,
            savingsLabel: p.savingsLabel,
            pricePerUnitLabel: p.pricePerUnitLabel,
            duration: p.duration,
            cardImage,
            detailBannerImages: detailBanners,
            detailBannerVideo: null,
            offersBanner: null,
            highlightsTitle: p.highlightsTitle,
            highlights: p.highlights,
            processTitle: p.processTitle,
            processSteps,
            whatsIncludedTitle: p.whatsIncludedTitle,
            whatsIncluded: p.whatsIncluded,
            requirementsTitle: p.requirementsTitle,
            requirements: p.need.map((label) => ({ iconUrl: '', label })),
            pleaseNoteTitle: p.pleaseNoteTitle,
            pleaseNote: p.pleaseNote,
            faqsTitle: p.faqsTitle,
            faqs: p.faqs,
            reviews: defaultReviews(p.name),
            features: p.highlights,
            displayOrder: pIdx,
            isPopular: pIdx === 0,
            isActive: true,
          };

          const existingPkg = await prisma.servicePackage.findFirst({
            where: { serviceId: service.id, name: p.name },
          });
          if (existingPkg) {
            await prisma.servicePackage.update({
              where: { id: existingPkg.id },
              data: packagePayload as any,
            });
          } else {
            await prisma.servicePackage.create({
              data: { serviceId: service.id, ...(packagePayload as any) },
            });
          }
          packageCount += 1;
          console.log(`    Package: ${p.name}  ₹${p.discountedPrice}`);
        }
      }
    }
  }

  const keepNames = new Set(
    CATALOG.flatMap((cat) => cat.subCategories.flatMap((sub) => sub.services.map((svc) => norm(svc.name))))
  );
  const leftovers = await prisma.service.findMany({
    include: { _count: { select: { bookings: true } } },
  });
  let retired = 0;
  for (const leftover of leftovers) {
    if (keepNames.has(norm(leftover.name))) continue;
    if (leftover.deletedAt && leftover.isActive === false) continue;
    if (leftover._count.bookings > 0) continue;
    await prisma.service.update({
      where: { id: leftover.id },
      data: { isActive: false, deletedAt: new Date() },
    });
    retired += 1;
    console.log(`  Retired leftover unused service: ${leftover.name}`);
  }

  return { catCount, subCount, serviceCount, packageCount, retired };
}

async function archiveExtraCategoriesAndPackages() {
  console.log('\n--- Archiving extra categories and leftover packages ---');
  const keepSlugs = new Set(CATALOG.map((cat) => cat.slug));
  const keepPkgNames = new Set(
    CATALOG.flatMap((cat) =>
      cat.subCategories.flatMap((sub) => sub.services.flatMap((svc) => svc.packages.map((p) => p.name)))
    )
  );
  const keepCategories = await prisma.serviceCategory.findMany({
    where: { slug: { in: [...keepSlugs] } },
  });
  const keepByName = new Map(keepCategories.map((cat) => [cat.name.toLowerCase(), cat]));

  const allCats = await prisma.serviceCategory.findMany();
  for (const cat of allCats) {
    if (keepSlugs.has(cat.slug)) continue;
    const target = keepByName.get(cat.name.toLowerCase());
    if (target) {
      await prisma.service.updateMany({
        where: { categoryId: cat.id, isActive: true },
        data: { categoryId: target.id },
      });
      await prisma.serviceSubCategory.updateMany({
        where: { categoryId: cat.id },
        data: { categoryId: target.id },
      });
    }
    if (!cat.deletedAt || cat.isActive) {
      await prisma.serviceCategory.update({
        where: { id: cat.id },
        data: { isActive: false, deletedAt: cat.deletedAt || new Date() },
      });
      console.log(`  Archived extra category: ${cat.name} (${cat.slug})`);
    }
  }

  const packages = await prisma.servicePackage.findMany({
    select: { id: true, name: true, title: true, isActive: true },
  });
  let deactivated = 0;
  for (const row of packages) {
    const label = row.name || row.title || '';
    if (keepPkgNames.has(label)) continue;
    if (row.isActive) {
      await prisma.servicePackage.update({ where: { id: row.id }, data: { isActive: false } });
      deactivated += 1;
    }
  }
  console.log(`  Deactivated leftover packages: ${deactivated}`);
}

async function printSummary() {
  const [categories, services, packages] = await Promise.all([
    prisma.serviceCategory.findMany({ where: { isActive: true }, select: { name: true, deletedAt: true } }),
    prisma.service.findMany({ where: { isActive: true }, select: { name: true, deletedAt: true } }),
    prisma.servicePackage.count({ where: { isActive: true } }),
  ]);
  const liveCategories = categories.filter((c) => !c.deletedAt);
  const liveServices = services.filter((s) => !s.deletedAt);
  const names = liveServices.map((s) => norm(s.name));
  const unique = new Set(names);
  console.log('\n========== LIVE DB COUNTS ==========');
  console.log(`Categories:           ${liveCategories.length}`);
  console.log(`Active services:      ${liveServices.length}`);
  console.log(`Unique service names: ${unique.size}`);
  console.log(`Active packages:      ${packages}`);
  if (unique.size !== liveServices.length) {
    const dups = names.filter((name, idx) => names.indexOf(name) !== idx);
    console.log(`WARNING still duplicated: ${[...new Set(dups)].join(', ')}`);
  } else {
    console.log('No duplicate service names remain.');
  }
}

async function main() {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary env is missing. Images must be hosted before catalog rows are saved.');
  }
  assertUniqueServiceNames(CATALOG);
  console.log('Catalog blueprint is unique. Starting import...');
  await archiveDuplicateServices();
  await mergeDuplicateSubcategories();
  const result = await upsertCatalog();
  console.log('\nUpserted:', result);
  await archiveDuplicateServices();
  await archiveExtraCategoriesAndPackages();
  await unsetLiveDeletedAt();
  await printSummary();
}

async function unsetLiveDeletedAt() {
  // Production Prisma rewrites deletedAt:null to isSet:false, so live rows must omit the field.
  await prisma.$runCommandRaw({
    update: 'Service',
    updates: [{ q: { isActive: true, deletedAt: null }, u: { $unset: { deletedAt: '' } }, multi: true }],
  });
  await prisma.$runCommandRaw({
    update: 'ServiceCategory',
    updates: [{ q: { isActive: true, deletedAt: null }, u: { $unset: { deletedAt: '' } }, multi: true }],
  });
  console.log('Unset deletedAt on live catalog rows so the public API can see them.');
}

main()
  .catch((error) => {
    console.error('Catalog seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
