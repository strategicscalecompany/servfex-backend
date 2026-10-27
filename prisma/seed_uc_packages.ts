import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// High quality, fast Unsplash CDN imagery for cleaning services
const IMAGES = {
  bathroom: {
    icon: 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=400&q=80',
    banners: [
      'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
    ],
    card: 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=600&q=80',
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
    card: 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=600&q=80',
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
    card: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=600&q=80',
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
    card: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=600&q=80',
    steps: [
      'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=600&q=80',
      'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=600&q=80',
      'https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?auto=format&fit=crop&w=600&q=80',
      'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=600&q=80',
    ],
  },
};

async function main() {
  console.log('--- Starting Urban Company Sub-Services & Packages Seeding ---');

  // Find all cleaning categories to ensure both user-created and standard categories are populated
  const allCats = await prisma.serviceCategory.findMany();
  console.log('All DB categories:', allCats.map(c => ({ id: c.id, name: c.name, deletedAt: c.deletedAt })));
  const cleaningCategories = allCats.filter(c => !c.deletedAt && c.name.toLowerCase().includes('cleaning'));
  console.log(`Found ${cleaningCategories.length} cleaning category targets:`, cleaningCategories.map(c => `${c.name} (${c.id})`));

  // Define 4 rich Sub-Categories with full Packages
  const subCategoriesData = [
    {
      name: 'Bathroom & Toilet Cleaning',
      iconUrl: IMAGES.bathroom.icon,
      bannerImages: IMAGES.bathroom.banners,
      serviceName: 'Bathroom Cleaning Services',
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
          cardImage: IMAGES.bathroom.card,
          detailBannerImages: IMAGES.bathroom.banners,
          highlightsTitle: 'Highlights',
          highlights: [
            'Deep stain removal from hard water deposits & yellow scaling',
            'Hospital-grade sanitization of commode, sink & taps',
            'Tile scrubbing with mechanized rotary brush',
            'Mirror & glass shine with streak-free formula',
            'Eco-friendly descaling solutions with zero toxic fumes',
          ],
          processTitle: 'Our 4-Step Cleaning Process',
          processSteps: [
            {
              stepNumber: 1,
              title: 'Pre-treatment & Descaling',
              description: 'Eco-friendly descaling solution is applied to tiles, commode, and chrome fittings to loosen hard water marks.',
              imageUrl: IMAGES.bathroom.steps[0],
            },
            {
              stepNumber: 2,
              title: 'Mechanized Tile Scrubbing',
              description: 'High-speed rotary brush scrubbers clean grout lines and wall tiles up to 7 feet.',
              imageUrl: IMAGES.bathroom.steps[1],
            },
            {
              stepNumber: 3,
              title: 'Fixtures & Chrome Buffing',
              description: 'Taps, shower head, mirror, and vanity unit are hand-buffed to a streak-free shine.',
              imageUrl: IMAGES.bathroom.steps[2],
            },
            {
              stepNumber: 4,
              title: 'Floor Vacuuming & Sanitization',
              description: 'Excess water is extracted using wet-vacuums, followed by antimicrobial floor wipe and deodorization.',
              imageUrl: IMAGES.bathroom.steps[3],
            },
          ],
          whatsIncludedTitle: "What's Included",
          whatsIncluded: [
            'Commode interior & exterior descaling',
            'Wall tiles scrubbed up to 7 feet height',
            'Washbasin, taps, mirror & shelf polishing',
            'Exhaust fan, geyser exterior & door wipe',
            'Floor scrubbed & dried with zero stagnant water',
          ],
          requirementsTitle: 'What We Need From You',
          requirements: [
            { iconUrl: '', label: 'Continuous water supply (hot or cold)' },
            { iconUrl: '', label: 'Electrical socket for rotary machine' },
            { iconUrl: '', label: 'Removal of personal toiletries before start' },
          ],
          pleaseNoteTitle: 'Please Note',
          pleaseNote: [
            'Hard water stains older than 6 months may fade by 70-80% but may not completely disappear.',
            'Tile regrouting or paint stain removal is not covered in regular cleaning.',
          ],
          faqsTitle: 'Frequently Asked Questions',
          faqs: [
            {
              question: 'How long does the service take?',
              answer: 'A standard bathroom takes approximately 60 to 75 minutes of intensive work.',
            },
            {
              question: 'Are the cleaning solutions safe for pets and children?',
              answer: 'Yes! We strictly use biodegradable, non-toxic descaling formulations that do not release harsh chemical fumes.',
            },
            {
              question: 'Do technicians bring their own machines and supplies?',
              answer: 'Yes, our certified professionals carry rotary scrubbers, specialized microfiber towels, and hospital-grade sanitizers.',
            },
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
          cardImage: IMAGES.bathroom.banners[1],
          detailBannerImages: IMAGES.bathroom.banners,
          highlightsTitle: 'Highlights',
          highlights: [
            'Double-pass mechanized tile scrubbing with heavy-duty descaler',
            'Drain cleaning and foul odor neutralizer application',
            'Full ceiling cobweb removal and ventilation duct cleaning',
            'Grout whitening and anti-fungal barrier treatment',
          ],
          processTitle: 'Restoration Workflow',
          processSteps: [
            {
              stepNumber: 1,
              title: 'Heavy Scale Soak',
              description: 'Industrial-grade safe acidic gel breaks down years of mineral build-up and soap scum.',
              imageUrl: IMAGES.bathroom.steps[0],
            },
            {
              stepNumber: 2,
              title: 'Double Rotary Scrub',
              description: 'Floor and walls undergo dual-pass machine scrubbing for maximum grit removal.',
              imageUrl: IMAGES.bathroom.steps[1],
            },
            {
              stepNumber: 3,
              title: 'Deep Sanitization & Drain Flush',
              description: 'Drain trap is cleared of hair/clogs and disinfected with boiling hot water flush.',
              imageUrl: IMAGES.bathroom.steps[2],
            },
          ],
          whatsIncludedTitle: "What's Included",
          whatsIncluded: [
            'All tiles scrubbed to ceiling height',
            'Deep commode and flush tank exterior detailing',
            'Drain trap clearing and anti-odor flush',
            'Mirror, glass partition & chrome descaling',
          ],
          requirementsTitle: 'What We Need From You',
          requirements: [
            { iconUrl: '', label: 'Uninterrupted power & water' },
            { iconUrl: '', label: 'Clear access to the bathroom' },
          ],
          pleaseNoteTitle: 'Please Note',
          pleaseNote: [
            'Broken tiles or corroded chrome plating cannot be mechanically repaired.',
          ],
          faqsTitle: 'Frequently Asked Questions',
          faqs: [
            {
              question: 'Will this remove severe yellow water stains?',
              answer: 'Yes, our restoration formula removes up to 90% of persistent mineral deposits on ceramic and porcelain.',
            },
          ],
        },
      ],
    },
    {
      name: 'Kitchen Deep Cleaning',
      iconUrl: IMAGES.kitchen.icon,
      bannerImages: IMAGES.kitchen.banners,
      serviceName: 'Kitchen Cleaning Services',
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
          cardImage: IMAGES.kitchen.card,
          detailBannerImages: IMAGES.kitchen.banners,
          highlightsTitle: 'Highlights',
          highlights: [
            'Complete degreasing of gas stove burners, dials, and stainless steel counter',
            'Tile backsplash oil & carbon stain removal',
            'Cabinet exterior detailing and handle sanitization',
            'Sink descaling and drain pipe unclogging flush',
            'Exhaust fan blades degreased and cleaned',
          ],
          processTitle: 'Our 4-Step Degreasing Process',
          processSteps: [
            {
              stepNumber: 1,
              title: 'Chemical Degreaser Soak',
              description: 'Food-grade alkaline foam is sprayed across the stove, backsplash tiles, and exhaust.',
              imageUrl: IMAGES.kitchen.steps[0],
            },
            {
              stepNumber: 2,
              title: 'Abrasive-Free Scrubbing',
              description: 'Special non-scratch nylon pads lift burnt carbon and sticky oil without dulling surfaces.',
              imageUrl: IMAGES.kitchen.steps[1],
            },
            {
              stepNumber: 3,
              title: 'Cabinet & Appliance Detailing',
              description: 'All modular cabinet doors, microwave exterior, and fridge exterior are wiped spotless.',
              imageUrl: IMAGES.kitchen.steps[2],
            },
            {
              stepNumber: 4,
              title: 'Sanitization & Counter Buffing',
              description: 'Granite/quartz counters are disinfected and machine-buffed to a clean hygienic shine.',
              imageUrl: IMAGES.kitchen.steps[3],
            },
          ],
          whatsIncludedTitle: "What's Included",
          whatsIncluded: [
            'Gas stove, knobs, burner rings & drip trays',
            'Wall tiles degreased up to ceiling level',
            'Cabinet exterior wipe & stain removal',
            'Kitchen sink, tap & water purifier exterior',
            'Floor mop with heavy-duty degreasing detergent',
          ],
          requirementsTitle: 'What We Need From You',
          requirements: [
            { iconUrl: '', label: 'Removal of open spices and utensils from countertops' },
            { iconUrl: '', label: 'Active water and electricity connection' },
          ],
          pleaseNoteTitle: 'Please Note',
          pleaseNote: [
            'Cleaning of internal cabinet contents is only done if cabinets are emptied prior to arrival.',
            'Chimney duct inner motor cleaning requires a specialized appliance add-on.',
          ],
          faqsTitle: 'Frequently Asked Questions',
          faqs: [
            {
              question: 'Do I need to empty all my kitchen cabinets?',
              answer: 'For standard service, we clean all cabinet exteriors. If you want inner shelves cleaned, please empty them before the technician arrives.',
            },
            {
              question: 'Does this service include the chimney?',
              answer: 'Exterior wiping and outer baffle filter degreasing are included. Deep motor disassembly requires our specialized Chimney add-on.',
            },
          ],
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
          cardImage: IMAGES.kitchen.banners[1],
          detailBannerImages: IMAGES.kitchen.banners,
          highlightsTitle: 'Highlights',
          highlights: [
            'Baffle / mesh filter boiling water degreasing bath',
            'Outer hood grease film removal and stainless steel polish',
            'Gas burner unclogging for blue flame efficiency',
            'Zero mess on kitchen counter guaranteed',
          ],
          processTitle: 'Degreasing Steps',
          processSteps: [
            {
              stepNumber: 1,
              title: 'Filter Dismantling',
              description: 'Filters are submerged in an industrial solvent bath to dissolve coagulated grease.',
              imageUrl: IMAGES.kitchen.steps[0],
            },
            {
              stepNumber: 2,
              title: 'Hood & Tray Detailing',
              description: 'Oil collector tray is drained, disinfected, and re-fitted cleanly.',
              imageUrl: IMAGES.kitchen.steps[1],
            },
          ],
          whatsIncludedTitle: "What's Included",
          whatsIncluded: [
            'Chimney filters chemical soak and rinse',
            'Chimney exterior hood wipe down',
            'Gas stove cooktop, burners & control dials',
          ],
          requirementsTitle: 'What We Need From You',
          requirements: [
            { iconUrl: '', label: 'Hot water availability for filter bath' },
          ],
          pleaseNoteTitle: 'Please Note',
          pleaseNote: [
            'Duct pipe replacement or electronic PCB repair is not included.',
          ],
          faqsTitle: 'Frequently Asked Questions',
          faqs: [
            {
              question: 'How often should chimney filters be degreased?',
              answer: 'For regular Indian cooking with spices and oil, chimney filters should be professionally cleaned every 2 to 3 months.',
            },
          ],
        },
      ],
    },
    {
      name: 'Full Home Deep Cleaning',
      iconUrl: IMAGES.fullHome.icon,
      bannerImages: IMAGES.fullHome.banners,
      serviceName: 'Full Home Deep Cleaning',
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
          cardImage: IMAGES.fullHome.card,
          detailBannerImages: IMAGES.fullHome.banners,
          highlightsTitle: 'Highlights',
          highlights: [
            'Complete floor machine scrubbing & buffing',
            'Balcony floor washing and railing wiping',
            'Ceiling fans, switchboards, tube lights & AC exterior wiped',
            'Window panes & mosquito mesh vacuumed and wiped',
            'Full bathroom & kitchen deep sanitization included',
          ],
          processTitle: 'Comprehensive 4-Stage Workflow',
          processSteps: [
            {
              stepNumber: 1,
              title: 'Dry Dusting & Vacuuming',
              description: 'Industrial suction vacuums capture deep dust from ceilings, curtain rods, and corners.',
              imageUrl: IMAGES.fullHome.steps[0],
            },
            {
              stepNumber: 2,
              title: 'Kitchen & Bath Disinfection',
              description: 'Technicians tackle tiles, counters, exhaust fans, and commodes simultaneously.',
              imageUrl: IMAGES.fullHome.steps[1],
            },
            {
              stepNumber: 3,
              title: 'Windows & Furniture Polishing',
              description: 'Glass panels, mirrors, wooden doors, and wardrobe exteriors are wiped streak-free.',
              imageUrl: IMAGES.fullHome.steps[2],
            },
            {
              stepNumber: 4,
              title: 'Single-Disc Floor Buffing',
              description: 'All tiled or marble floors are mechanically scrubbed and buffed for a high-gloss finish.',
              imageUrl: IMAGES.fullHome.steps[3],
            },
          ],
          whatsIncludedTitle: "What's Included",
          whatsIncluded: [
            '1 Bedroom, Living Room, 1 Kitchen & up to 2 Bathrooms',
            'Ceiling fan blades, light fixtures & AC exterior wipe',
            'Window frames, glass panes & wire mesh cleaning',
            'Machine floor scrubbing throughout the apartment',
          ],
          requirementsTitle: 'What We Need From You',
          requirements: [
            { iconUrl: '', label: 'Unrestricted water & high-voltage power supply' },
            { iconUrl: '', label: 'Safe storage of jewelry, cash, and sensitive documents' },
          ],
          pleaseNoteTitle: 'Please Note',
          pleaseNote: [
            'Deep sofa or carpet shampooing is separate and can be bundled with this service.',
          ],
          faqsTitle: 'Frequently Asked Questions',
          faqs: [
            {
              question: 'How many professionals will come?',
              answer: 'A team of 2 to 3 trained professionals equipped with single-disc scrubbers and commercial vacuums is deployed.',
            },
          ],
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
          cardImage: IMAGES.fullHome.banners[1],
          detailBannerImages: IMAGES.fullHome.banners,
          highlightsTitle: 'Highlights',
          highlights: [
            '2 Bedrooms + Living/Dining + Kitchen + 2 Bathrooms + Balcony',
            'Heavy-duty floor scrubbing with single-disc buffing machine',
            'Streak-free glass cleaning for all windows and sliders',
            'Hospital-grade germicidal fogging and deodorization',
          ],
          processTitle: '5-Step Cleaning Protocol',
          processSteps: [
            {
              stepNumber: 1,
              title: 'High-Reach Dusting',
              description: 'Cobweb removal, fan blades, top of wardrobes, and air conditioner vents.',
              imageUrl: IMAGES.fullHome.steps[0],
            },
            {
              stepNumber: 2,
              title: 'Wet Vacuuming & Degreasing',
              description: 'Kitchen and bathrooms scrubbed with mechanized tools.',
              imageUrl: IMAGES.fullHome.steps[1],
            },
            {
              stepNumber: 3,
              title: 'Mechanized Floor Buffing',
              description: 'Entire house floors buffed with micro-abrasive pads.',
              imageUrl: IMAGES.fullHome.steps[2],
            },
          ],
          whatsIncludedTitle: "What's Included",
          whatsIncluded: [
            'Entire 2 BHK apartment deep cleaning',
            '2 Bathrooms sanitized and descaled',
            'Balcony floor washed and drained',
            'Door frames, baseboards, switchboards detailed',
          ],
          requirementsTitle: 'What We Need From You',
          requirements: [
            { iconUrl: '', label: 'Access to all rooms throughout the 5-6 hour duration' },
          ],
          pleaseNoteTitle: 'Please Note',
          pleaseNote: [
            'Exterior wall cleaning or terrace cleaning is not included in standard apartment plans.',
          ],
          faqsTitle: 'Frequently Asked Questions',
          faqs: [
            {
              question: 'Can we stay in the home while the cleaning happens?',
              answer: 'Yes! The team cleans room by room, allowing you to comfortably occupy another room while work is underway.',
            },
          ],
        },
        {
          name: '3 BHK Deep Home Cleaning',
          sectionTitle: 'Apartment Packages',
          badgeText: 'FAMILY PACK',
          shortDescription: 'Comprehensive full-house detailing for 3 BHK apartments and duplexes up to 1800 sq ft',
          originalPrice: '6499.00',
          discountedPrice: '4799.00',
          savingsLabel: 'Save ₹1700 (26% off)',
          duration: '6-7 hours',
          pricePerUnitLabel: 'per apartment',
          cardImage: IMAGES.fullHome.banners[2],
          detailBannerImages: IMAGES.fullHome.banners,
          highlightsTitle: 'Highlights',
          highlights: [
            '3 Bedrooms + Large Living Area + Kitchen + 3 Bathrooms + Balconies',
            'Dedicated 3 to 4 technician squad with industrial gear',
            'Full window tracks, sliding channels & glass treatment',
            'Deep kitchen degreasing & full bathroom descaling',
          ],
          processTitle: 'Full Day Protocol',
          processSteps: [
            {
              stepNumber: 1,
              title: 'Complete Deep Vacuum',
              description: 'Dry vacuuming of mattresses, sofa crevices, curtains, and high ceiling cornices.',
              imageUrl: IMAGES.fullHome.steps[0],
            },
            {
              stepNumber: 2,
              title: 'Intensive Floor Treatment',
              description: 'All floor surfaces stripped of stubborn grime and buffed to a radiant shine.',
              imageUrl: IMAGES.fullHome.steps[1],
            },
          ],
          whatsIncludedTitle: "What's Included",
          whatsIncluded: [
            '3 Bedrooms, Living/Dining, Kitchen & 3 Bathrooms',
            'All balconies, utility areas, window sliders & grill wiping',
            'Wardrobe exteriors, dressing tables, mirrors & doors',
          ],
          requirementsTitle: 'What We Need From You',
          requirements: [
            { iconUrl: '', label: 'Electricity & water supply' },
          ],
          pleaseNoteTitle: 'Please Note',
          pleaseNote: [
            'Interior cabinet cleaning requires items to be packed or emptied in advance.',
          ],
          faqsTitle: 'Frequently Asked Questions',
          faqs: [
            {
              question: 'Do you clean ceiling fans and chandelier fixtures?',
              answer: 'Ceiling fans and standard lights are thoroughly wiped. Delicate crystal chandeliers are dusted with feather brushes.',
            },
          ],
        },
      ],
    },
    {
      name: 'Sofa & Upholstery Cleaning',
      iconUrl: IMAGES.sofa.icon,
      bannerImages: IMAGES.sofa.banners,
      serviceName: 'Sofa & Carpet Cleaning',
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
          cardImage: IMAGES.sofa.card,
          detailBannerImages: IMAGES.sofa.banners,
          highlightsTitle: 'Highlights',
          highlights: [
            'High-power dry vacuuming to remove deep-seated dust mites',
            'Foaming shampoo application with specialized fabric brush',
            'High-suction extraction lifts 90% moisture along with dissolved stains',
            'Aroma fresh deodorizer treatment leaves sofa smelling new',
          ],
          processTitle: 'Our 3-Step Shampoo Process',
          processSteps: [
            {
              stepNumber: 1,
              title: 'Dry Extraction',
              description: 'Commercial 1400W vacuum extracts loose dirt, allergens, and dust mites from crevices.',
              imageUrl: IMAGES.sofa.steps[0],
            },
            {
              stepNumber: 2,
              title: 'Fabric Shampoo Agitation',
              description: 'German non-ionic foam shampoo is worked into fabric fibers using soft-bristle agitators.',
              imageUrl: IMAGES.sofa.steps[1],
            },
            {
              stepNumber: 3,
              title: 'Moisture & Sludge Extraction',
              description: 'Twin-motor extraction vacuum sucks out 90% of moisture and all dissolved stains.',
              imageUrl: IMAGES.sofa.steps[2],
            },
          ],
          whatsIncludedTitle: "What's Included",
          whatsIncluded: [
            'Full 3-seater fabric sofa (seats, backrests, and side armrests)',
            'Stain spot-treatment for coffee/tea/food spills',
            'Deodorizing spray application',
          ],
          requirementsTitle: 'What We Need From You',
          requirements: [
            { iconUrl: '', label: 'Electrical socket within 5 meters' },
            { iconUrl: '', label: 'Allow 3 to 4 hours under ceiling fan for complete drying' },
          ],
          pleaseNoteTitle: 'Please Note',
          pleaseNote: [
            'Ink, turmeric, or old chemical stains may fade significantly but cannot be 100% guaranteed.',
            'Leather/leatherette sofas require a dedicated leather cream conditioning service.',
          ],
          faqsTitle: 'Frequently Asked Questions',
          faqs: [
            {
              question: 'How long does the sofa take to dry after cleaning?',
              answer: 'Because of our commercial extraction technology, the sofa is only slightly damp and dries completely within 3 to 4 hours under a regular ceiling fan.',
            },
            {
              question: 'Does this service damage sofa fabric color or texture?',
              answer: 'No! Our shampoo is pH-balanced and color-safe, keeping velvet, linen, cotton, and polyester fabrics soft and bright.',
            },
          ],
        },
        {
          name: '5-Seater Sofa Set Shampooing',
          sectionTitle: 'Sofa Shampooing',
          badgeText: 'FAMILY VALUE',
          shortDescription: 'Complete wet shampooing & moisture extraction for 3+1+1 or L-shape 5-seater sofa sets',
          originalPrice: '1399.00',
          discountedPrice: '999.00',
          savingsLabel: 'Save ₹400 (29% off)',
          duration: '90 mins',
          pricePerUnitLabel: 'per 5-seater set',
          cardImage: IMAGES.sofa.banners[1],
          detailBannerImages: IMAGES.sofa.banners,
          highlightsTitle: 'Highlights',
          highlights: [
            'Full 5 seats treated with fabric shampoo & deep extraction',
            'Free complimentary cushion cleaning (up to 4 cushions)',
            'Anti-allergen sanitized finish for safe lounging',
          ],
          processTitle: 'Deep Clean Protocol',
          processSteps: [
            {
              stepNumber: 1,
              title: 'Crevice Vacuuming',
              description: 'Deep suction cleaning behind and under sofa cushions.',
              imageUrl: IMAGES.sofa.steps[0],
            },
            {
              stepNumber: 2,
              title: 'Injection-Extraction',
              description: 'Shampoo injection and immediate dirty water extraction.',
              imageUrl: IMAGES.sofa.steps[1],
            },
          ],
          whatsIncludedTitle: "What's Included",
          whatsIncluded: [
            '5-seater sofa (3+1+1 or 5-seater L-Shape section)',
            'Up to 4 loose backrest cushions',
            'Sanitization & deodorization',
          ],
          requirementsTitle: 'What We Need From You',
          requirements: [
            { iconUrl: '', label: 'Standard electrical outlet' },
          ],
          pleaseNoteTitle: 'Please Note',
          pleaseNote: [
            'Please keep ceiling fans running after service to ensure quick drying.',
          ],
          faqsTitle: 'Frequently Asked Questions',
          faqs: [
            {
              question: 'Does this cover cushions?',
              answer: 'Yes! Up to 4 removable sofa cushions are shampooed free of cost with this package.',
            },
          ],
        },
      ],
    },
  ];

  for (const cleaningCategory of cleaningCategories) {
    console.log(`\n================================================================`);
    console.log(`Populating Category: "${cleaningCategory.name}" (${cleaningCategory.id})`);
    console.log(`================================================================`);

    for (let scIdx = 0; scIdx < subCategoriesData.length; scIdx++) {
      const scData = subCategoriesData[scIdx];
      console.log(`\nProcessing Sub-Category: ${scData.name}...`);

      // Check if sub-category already exists under this category
      let subCat = await prisma.serviceSubCategory.findFirst({
        where: {
          categoryId: cleaningCategory.id,
          name: scData.name,
        },
      });

      if (!subCat) {
        subCat = await prisma.serviceSubCategory.create({
          data: {
            categoryId: cleaningCategory.id,
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

      // Ensure backing service exists
      const baseSlug = scData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
      let service = await prisma.service.findFirst({
        where: {
          subCategoryId: subCat.id,
          deletedAt: null,
        },
      });

      if (!service) {
        service = await prisma.service.create({
          data: {
            categoryId: cleaningCategory.id,
            subCategoryId: subCat.id,
            name: scData.name,
            slug: `${baseSlug}-${Date.now().toString().slice(-4)}`,
            description: `Professional ${scData.name} by certified background-verified technicians`,
            iconUrl: scData.iconUrl,
            startingPrice: scData.packages[0]?.discountedPrice || '499.00',
            priceUnit: 'per service',
            durationText: scData.packages[0]?.duration || '60 mins',
            rating: 4.88,
            reviewCount: 142,
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

      // Now insert / update each package
      for (let pkgIdx = 0; pkgIdx < scData.packages.length; pkgIdx++) {
        const pData = scData.packages[pkgIdx];

        // Check if package already exists under this service
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
          displayOrder: pkgIdx,
          isPopular: pkgIdx === 0,
          isActive: true,
          // Legacy compat fields
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

  console.log('\n✅ All Urban Company Sub-Services & Packages seeded successfully!');
}

main()
  .catch((err) => {
    console.error('Error seeding packages:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
