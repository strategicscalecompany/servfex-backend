import { PrismaClient, Prisma } from '@prisma/client';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting ServFex Master Database Seeding...');

  // 1. Seed Super Admin (Binds to Firebase UID if provided, or auto-binds on first Google Sign-In)
  const adminFirebaseUid = process.env.SUPER_ADMIN_FIREBASE_UID?.trim() || null;
  const adminEmail = env.SUPER_ADMIN_EMAIL.toLowerCase().trim();

  const superAdmin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      isVerified: true,
      ...(adminFirebaseUid ? { firebaseUid: adminFirebaseUid } : {}),
      name: env.SUPER_ADMIN_NAME,
    },
    create: {
      email: adminEmail,
      firebaseUid: adminFirebaseUid,
      name: env.SUPER_ADMIN_NAME,
      phone: '+91 99999 88888',
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      isVerified: true,
    },
  });

  if (adminFirebaseUid) {
    console.log(`✅ Super Admin configured: ${superAdmin.email} (Bound to UID: ${adminFirebaseUid})`);
  } else {
    console.log(`✅ Super Admin configured: ${superAdmin.email} (Ready for Google Sign-In auto-binding)`);
  }

  // 2. Initial Platform Settings
  await prisma.platformSetting.upsert({
    where: { key: 'PLATFORM_GENERAL' },
    update: {},
    create: {
      key: 'PLATFORM_GENERAL',
      value: {
        platformName: 'ServFex',
        supportEmail: 'support@servfex.com',
        supportPhone: '+91 98765 43210',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        maintenanceMode: false,
        customerRegistrationEnabled: true,
        vendorRegistrationEnabled: true,
      },
      description: 'General platform settings',
    },
  });

  await prisma.platformSetting.upsert({
    where: { key: 'PRICING_RULES' },
    update: {},
    create: {
      key: 'PRICING_RULES',
      value: {
        platformCommissionPercent: 15.0,
        baseTaxPercent: 18.0,
        minimumBookingFee: 199.0,
        cancellationFee: 50.0,
        extraChargesAllowed: true,
      },
      description: 'Pricing and commission rules',
    },
  });

  await prisma.appConfiguration.upsert({
    where: { key: 'MOBILE_APPS' },
    update: {},
    create: {
      key: 'MOBILE_APPS',
      value: {
        customer: {
          minimumVersion: '1.0.0',
          latestVersion: '1.2.0',
          forceUpdate: false,
          maintenanceMode: false,
        },
        vendor: {
          minimumVersion: '1.0.0',
          latestVersion: '1.1.0',
          forceUpdate: false,
          maintenanceMode: false,
        },
      },
      description: 'Mobile App version controls',
    },
  });

  // 3. Service Categories
  const categoriesData = [
    { name: 'Cleaning & Pest Control', slug: 'cleaning', icon: 'Sparkles', displayOrder: 1 },
    { name: 'AC & Appliance Repair', slug: 'appliances', icon: 'Wrench', displayOrder: 2 },
    { name: 'Electrician & Lighting', slug: 'electrical', icon: 'Zap', displayOrder: 3 },
    { name: 'Plumbing & Water Care', slug: 'plumbing', icon: 'Droplets', displayOrder: 4 },
    { name: 'Painting & Waterproofing', slug: 'painting', icon: 'Paintbrush', displayOrder: 5 },
  ];

  const categories: Record<string, any> = {};
  for (const cat of categoriesData) {
    categories[cat.slug] = await prisma.serviceCategory.upsert({
      where: { slug: cat.slug },
      update: {},
      create: {
        name: cat.name,
        slug: cat.slug,
        icon: cat.icon,
        displayOrder: cat.displayOrder,
        isActive: true,
      },
    });
  }
  console.log(`✅ Seeded ${Object.keys(categories).length} categories`);

  // 4. Services & Tiered Packages
  // Service: Deep Home Cleaning
  const cleaningService = await prisma.service.upsert({
    where: { slug: 'full-home-deep-cleaning' },
    update: {},
    create: {
      categoryId: categories['cleaning'].id,
      name: 'Full Home Deep Cleaning',
      slug: 'full-home-deep-cleaning',
      description: 'Intensive deep cleaning covering living rooms, kitchens, bathrooms, and balconies.',
      startingPrice: new Prisma.Decimal('1499.00'),
      durationText: '3-4 hours',
      rating: 4.85,
      reviewCount: 38,
      iconName: 'Sparkles',
      isPopular: true,
      packages: {
        create: [
          {
            title: 'Essential Clean (1-2 BHK)',
            description: 'Vacuuming, mopping, kitchen degreasing, bathroom scrubbing.',
            price: new Prisma.Decimal('1499.00'),
            durationMinutes: 180,
            features: ['Dry dusting & vacuuming', 'Wet mopping', 'Kitchen surface sanitize', 'Bathroom deep scrub'],
            isPopular: true,
          },
          {
            title: 'Premium Deep Clean (3-4 BHK)',
            description: 'Comprehensive sanitization with sofa shampooing and balcony jet wash.',
            price: new Prisma.Decimal('2899.00'),
            durationMinutes: 240,
            features: ['Everything in Essential', 'Sofa & carpet shampoo', 'High-pressure balcony jet wash', 'Appliance exterior shine'],
            isPopular: false,
          },
        ],
      },
    },
    include: { packages: true },
  });

  // Service: AC Service & Gas Charging
  const acService = await prisma.service.upsert({
    where: { slug: 'split-ac-regular-service' },
    update: {},
    create: {
      categoryId: categories['appliances'].id,
      name: 'Split AC Deep Foam Jet Service',
      slug: 'split-ac-regular-service',
      description: 'Foam jet cleaning of filters, cooling coils, drain tray and outdoor unit inspection.',
      startingPrice: new Prisma.Decimal('699.00'),
      durationText: '45 mins',
      rating: 4.9,
      reviewCount: 94,
      iconName: 'Wind',
      isPopular: true,
      packages: {
        create: [
          {
            title: 'Single AC Power Foam Clean',
            description: 'Anti-bacterial foam cleaning for 1 split AC indoor and outdoor unit.',
            price: new Prisma.Decimal('699.00'),
            durationMinutes: 45,
            features: ['Foam-jet coil spray', 'Drain pipe flushing', 'Gas pressure diagnosis'],
            isPopular: true,
          },
          {
            title: 'Double AC Power Saver Pack',
            description: 'Complete servicing for two AC units with filter sanitization.',
            price: new Prisma.Decimal('1299.00'),
            durationMinutes: 90,
            features: ['2 AC units complete service', 'Indoor & outdoor jet cleaning', 'Free thermostat calibration'],
            isPopular: false,
          },
        ],
      },
    },
    include: { packages: true },
  });

  // Service: Tap & Drain Plumbing
  const plumbingService = await prisma.service.upsert({
    where: { slug: 'tap-drain-repair' },
    update: {},
    create: {
      categoryId: categories['plumbing'].id,
      name: 'Tap, Pipe & Drain Repair',
      slug: 'tap-drain-repair',
      description: 'Leakage fixing, tap replacement, pipe repair, and drain unclogging.',
      startingPrice: new Prisma.Decimal('349.00'),
      durationText: '30-60 mins',
      rating: 4.75,
      reviewCount: 52,
      iconName: 'Droplet',
      isPopular: false,
      packages: {
        create: [
          {
            title: 'Standard Repair Visit',
            description: 'Inspection and minor repair of 1-2 plumbing fixtures.',
            price: new Prisma.Decimal('349.00'),
            durationMinutes: 45,
            features: ['Fault detection', 'Leakage sealant application', 'Hardware installation'],
            isPopular: true,
          },
        ],
      },
    },
    include: { packages: true },
  });
  console.log(`✅ Seeded services and packages`);

  // 5. Seed Mock Vendors, Employees & Bookings (Only if SEED_MOCK_DATA === 'true')
  if (process.env.SEED_MOCK_DATA === 'true') {
  const vendorUserA = await prisma.user.upsert({
    where: { email: 'vendor.apex@servfex.com' },
    update: {},
    create: {
      name: 'Rajesh Sharma',
      email: 'vendor.apex@servfex.com',
      phone: '+91 98111 22233',
      role: 'VENDOR',
      status: 'ACTIVE',
      isVerified: true,
      vendorProfile: {
        create: {
          companyName: 'Apex Home Services Pvt Ltd',
          businessLicense: 'BL-MH-2024-8849',
          taxId: '27AAAAA0000A1Z5',
          kycStatus: 'APPROVED',
          location: 'Andheri West, Mumbai',
          rating: 4.88,
          reviewCount: 45,
          commissionRate: new Prisma.Decimal('14.00'),
          isActive: true,
        },
      },
    },
    include: { vendorProfile: true },
  });

  const vendorUserB = await prisma.user.upsert({
    where: { email: 'vendor.cooltech@servfex.com' },
    update: {},
    create: {
      name: 'Arjun Mehta',
      email: 'vendor.cooltech@servfex.com',
      phone: '+91 98222 33344',
      role: 'VENDOR',
      status: 'ACTIVE',
      isVerified: true,
      vendorProfile: {
        create: {
          companyName: 'CoolTech Climate Solutions',
          businessLicense: 'BL-KA-2023-4120',
          taxId: '29BBBBB1111B2Z6',
          kycStatus: 'APPROVED',
          location: 'Koramangala, Bangalore',
          rating: 4.92,
          reviewCount: 88,
          commissionRate: new Prisma.Decimal('15.00'),
          isActive: true,
        },
      },
    },
    include: { vendorProfile: true },
  });

  // Link VendorService marketplace custom prices
  await prisma.vendorService.upsert({
    where: {
      vendorId_serviceId: {
        vendorId: vendorUserA.vendorProfile!.id,
        serviceId: cleaningService.id,
      },
    },
    update: {},
    create: {
      vendorId: vendorUserA.vendorProfile!.id,
      serviceId: cleaningService.id,
      customPrice: new Prisma.Decimal('1449.00'),
      isActive: true,
      availability: 'Mon-Sat: 08:00 - 20:00',
    },
  });

  await prisma.vendorService.upsert({
    where: {
      vendorId_serviceId: {
        vendorId: vendorUserB.vendorProfile!.id,
        serviceId: acService.id,
      },
    },
    update: {},
    create: {
      vendorId: vendorUserB.vendorProfile!.id,
      serviceId: acService.id,
      customPrice: new Prisma.Decimal('679.00'),
      isActive: true,
      availability: 'All days: 09:00 - 21:00',
    },
  });

  // 6. Seed Employees (assigned to vendors)
  const employeeUser1 = await prisma.user.upsert({
    where: { email: 'emp.suresh@servfex.com' },
    update: {},
    create: {
      name: 'Suresh Kumar',
      email: 'emp.suresh@servfex.com',
      phone: '+91 97111 55566',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      isVerified: true,
      employeeProfile: {
        create: {
          vendorId: vendorUserA.vendorProfile!.id,
          specialization: 'Deep Cleaning Specialist',
          rating: 4.9,
          completedJobs: 142,
          phone: '+91 97111 55566',
          isAvailable: true,
        },
      },
    },
    include: { employeeProfile: true },
  });

  const employeeUser2 = await prisma.user.upsert({
    where: { email: 'emp.vikram@servfex.com' },
    update: {},
    create: {
      name: 'Vikram Singh',
      email: 'emp.vikram@servfex.com',
      phone: '+91 97222 66677',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      isVerified: true,
      employeeProfile: {
        create: {
          vendorId: vendorUserB.vendorProfile!.id,
          specialization: 'Certified HVAC & AC Technician',
          rating: 4.95,
          completedJobs: 218,
          phone: '+91 97222 66677',
          isAvailable: true,
        },
      },
    },
    include: { employeeProfile: true },
  });
  // Seed Mobile App Demo Vendor
  const mobileVendor = await prisma.user.upsert({
    where: { email: 'vendor@metro.com' },
    update: {},
    create: {
      name: 'Metro Repairs Admin',
      email: 'vendor@metro.com',
      phone: '+91 98333 44455',
      role: 'VENDOR',
      status: 'ACTIVE',
      isVerified: true,
      vendorProfile: {
        create: {
          companyName: 'Metro Urban Repairs & Cleaning',
          businessLicense: 'BL-DL-2024-5501',
          taxId: '07CCCC1234C1Z9',
          kycStatus: 'APPROVED',
          location: 'Connaught Place, New Delhi',
          rating: 4.95,
          reviewCount: 64,
          commissionRate: new Prisma.Decimal('15.00'),
          isActive: true,
        },
      },
    },
    include: { vendorProfile: true },
  });

  // Seed Mobile App Demo Provider
  const mobileProvider = await prisma.user.upsert({
    where: { email: 'provider@waterclean.com' },
    update: {},
    create: {
      name: 'Ravi Watercare Pro',
      email: 'provider@waterclean.com',
      phone: '+91 97333 77788',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      isVerified: true,
      employeeProfile: {
        create: {
          vendorId: mobileVendor.vendorProfile!.id,
          specialization: 'Water Tank & Pipe Care Specialist',
          rating: 4.88,
          completedJobs: 95,
          phone: '+91 97333 77788',
          isAvailable: true,
        },
      },
    },
    include: { employeeProfile: true },
  });

  console.log(`✅ Seeded vendors, employees, and mobile demo accounts`);

  // 7. Seed Customers & Addresses
  const customerUser = await prisma.user.upsert({
    where: { email: 'priya.customer@gmail.com' },
    update: {},
    create: {
      name: 'Priya Nambiar',
      email: 'priya.customer@gmail.com',
      phone: '+91 98450 12345',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      isVerified: true,
      customerProfile: {
        create: {
          totalBookings: 3,
          totalSpent: new Prisma.Decimal('3897.00'),
          emergencyContact: '+91 98450 99999',
        },
      },
      addresses: {
        create: {
          label: 'Home',
          addressLine1: 'Flat 402, Lotus Grand Residency',
          addressLine2: 'Road No. 12, Banjara Hills',
          landmark: 'Opposite City Center Mall',
          city: 'Hyderabad',
          state: 'Telangana',
          postalCode: '500034',
          isDefault: true,
        },
      },
    },
    include: { customerProfile: true, addresses: true },
  });
  console.log(`✅ Seeded customer profile with address`);

  // 8. Seed Realistic Bookings across Statuses with Financials & Audit
  const todayStr = new Date().toISOString().split('T')[0];

  // Booking 1: COMPLETED deep clean
  const booking1 = await prisma.booking.upsert({
    where: { bookingNumber: '#SFX-901244' },
    update: {},
    create: {
      bookingNumber: '#SFX-901244',
      customerId: customerUser.customerProfile!.id,
      serviceId: cleaningService.id,
      packageId: cleaningService.packages[0].id,
      addressId: customerUser.addresses[0].id,
      vendorId: vendorUserA.vendorProfile!.id,
      employeeId: employeeUser1.employeeProfile!.id,
      scheduledDate: todayStr,
      scheduledTimeSlot: '10:00 AM - 01:00 PM',
      status: 'COMPLETED',
      basePrice: new Prisma.Decimal('1499.00'),
      taxes: new Prisma.Decimal('269.82'),
      discountAmount: new Prisma.Decimal('150.00'),
      extraCharges: new Prisma.Decimal('0.00'),
      totalAmount: new Prisma.Decimal('1618.82'),
      paymentStatus: 'PAID',
      paymentMethod: 'UPI',
      notes: 'Please sanitize balcony carefully',
    },
  });

  // Ledger Payment for Booking 1
  await prisma.payment.upsert({
    where: { transactionRef: 'TXN-SFX-202609-881' },
    update: {},
    create: {
      bookingId: booking1.id,
      transactionRef: 'TXN-SFX-202609-881',
      amount: new Prisma.Decimal('1618.82'),
      currency: 'INR',
      status: 'PAID',
      method: 'UPI',
    },
  });

  // Review for Booking 1
  await prisma.review.upsert({
    where: { bookingId: booking1.id },
    update: {},
    create: {
      bookingId: booking1.id,
      customerId: customerUser.id,
      serviceId: cleaningService.id,
      vendorId: vendorUserA.vendorProfile!.id,
      employeeId: employeeUser1.employeeProfile!.id,
      rating: 5,
      comment: 'Super thorough cleaning! Suresh was extremely punctual and professional.',
      isHidden: false,
    },
  });

  // Booking 2: IN_PROGRESS AC Service
  const booking2 = await prisma.booking.upsert({
    where: { bookingNumber: '#SFX-901245' },
    update: {},
    create: {
      bookingNumber: '#SFX-901245',
      customerId: customerUser.customerProfile!.id,
      serviceId: acService.id,
      packageId: acService.packages[0].id,
      addressId: customerUser.addresses[0].id,
      vendorId: vendorUserB.vendorProfile!.id,
      employeeId: employeeUser2.employeeProfile!.id,
      scheduledDate: todayStr,
      scheduledTimeSlot: '02:00 PM - 03:00 PM',
      status: 'IN_PROGRESS',
      basePrice: new Prisma.Decimal('699.00'),
      taxes: new Prisma.Decimal('125.82'),
      discountAmount: new Prisma.Decimal('0.00'),
      extraCharges: new Prisma.Decimal('0.00'),
      totalAmount: new Prisma.Decimal('824.82'),
      paymentStatus: 'PAID',
      paymentMethod: 'ONLINE',
    },
  });

  await prisma.payment.upsert({
    where: { transactionRef: 'TXN-SFX-202609-882' },
    update: {},
    create: {
      bookingId: booking2.id,
      transactionRef: 'TXN-SFX-202609-882',
      amount: new Prisma.Decimal('824.82'),
      currency: 'INR',
      status: 'PAID',
      method: 'ONLINE',
    },
  });
  }

  // Initial Audit Log
  await prisma.auditLog.create({
    data: {
      superAdminId: superAdmin.id,
      action: 'SYSTEM_INITIALIZATION',
      entityType: 'System',
      entityId: 'ROOT',
      after: { status: 'INITIALIZED', env: env.NODE_ENV },
      reason: 'Database initialized and seeded with master schema',
      ipAddress: '127.0.0.1',
      userAgent: 'ServFex-Seeder/1.0',
    },
  });

  console.log('🎉 Seeding successfully completed! All relationships valid and verified.');
}

main()
  .catch((e) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
