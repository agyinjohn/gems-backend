require('dotenv').config();
const bcrypt = require('bcryptjs');
const connectDB = require('./db');
const {
  Tenant, Branch, User, Category, Department, Product, Account, Supplier, Customer,
  Order, Lead, Employee, Expense, PurchaseOrder, StockMovement, JournalEntry,
  Attendance, LeaveRequest,
} = require('../models');
const { seedChartOfAccounts } = require('../services/accountingService');

// helpers
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const daysAgo = n => new Date(Date.now() - n * 86400000);
const monthsAgo = (m, day = 15) => {
  const d = new Date();
  d.setMonth(d.getMonth() - m);
  d.setDate(day);
  return d;
};

const seed = async () => {
  await connectDB();
  console.log('Seeding database...');

  // Platform Admin (us)
  const adminHash = await bcrypt.hash('Admin@1234', 10);
  await User.findOneAndUpdate(
    { email: 'admin@gthink.com' },
    { name: 'Platform Admin', email: 'admin@gthink.com', password_hash: adminHash, role: 'platform_admin', tenant_id: null, branch_id: null },
    { upsert: true, new: true },
  );

  // Demo Tenant
  const tenant = await Tenant.findOneAndUpdate(
    { slug: 'gems-store' },
    { business_name: 'GEMS Store', slug: 'gems-store', email: 'owner@gems-store.com', plan: 'pro', subscription_status: 'active', subscription_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), max_branches: 5, max_users: 20 },
    { upsert: true, new: true },
  );

  // Default Branch
  const branch = await Branch.findOneAndUpdate(
    { tenant_id: tenant._id, slug: 'main' },
    { tenant_id: tenant._id, name: 'Main Branch', slug: 'main', address: 'Accra, Ghana', email: 'main@gems-store.com' },
    { upsert: true, new: true },
  );

  // Tenant Users
  const staffHash = await bcrypt.hash('Staff@1234', 10);
  const ownerHash = await bcrypt.hash('Admin@1234', 10);
  await User.findOneAndUpdate(
    { email: 'owner@gems-store.com' },
    { tenant_id: tenant._id, branch_id: null, name: 'Kofi Mensah (Owner)', email: 'owner@gems-store.com', password_hash: ownerHash, role: 'business_owner' },
    { upsert: true, new: true },
  );
  const staffDefs = [
    { name: 'Kwame Asante',  email: 'sales@gthink.com',        role: 'sales_staff',         branch_id: branch._id },
    { name: 'Abena Mensah',  email: 'warehouse@gthink.com',    role: 'warehouse_staff',      branch_id: branch._id },
    { name: 'Kofi Boateng',  email: 'accounts@gthink.com',     role: 'accountant',           branch_id: null },
    { name: 'Ama Owusu',     email: 'hr@gthink.com',           role: 'hr_manager',           branch_id: null },
    { name: 'Yaw Darko',     email: 'procurement@gthink.com',  role: 'procurement_officer',  branch_id: null },
  ];
  for (const s of staffDefs) {
    await User.findOneAndUpdate({ email: s.email }, { ...s, tenant_id: tenant._id, password_hash: staffHash }, { upsert: true });
  }
  const adminUser = await User.findOne({ email: 'owner@gems-store.com' });
  const salesUser = await User.findOne({ email: 'sales@gthink.com' });

  // Categories
  const catNames = ['Electronics', 'Office Supplies', 'Furniture', 'Clothing', 'Food & Beverage', 'Tools & Equipment'];
  const catMap = {};
  for (const name of catNames) {
    const cat = await Category.findOneAndUpdate({ tenant_id: tenant._id, name }, { tenant_id: tenant._id, name }, { upsert: true, new: true });
    catMap[name] = cat._id;
  }

    // ── Departments ────────────────────────────────────────────────────────────
  const deptNames = ['Administration', 'Sales', 'Warehouse', 'Finance', 'Human Resources', 'Procurement', 'IT'];
  const deptMap = {};
  for (const name of deptNames) {
    const dept = await Department.findOneAndUpdate({ tenant_id: tenant._id, name }, { tenant_id: tenant._id, name }, { upsert: true, new: true });
    deptMap[name] = dept._id;
  }

  // ── Products ───────────────────────────────────────────────────────────────
  const productDefs = [
    // Electronics (10)
    { name: 'Laptop Pro 15"',              sku: 'ELEC-001', cat: 'Electronics',       price: 3500,  cost_price: 2800, stock_qty: 25,  description: 'High-performance laptop with Intel Core i7, 16GB RAM, 512GB SSD.',         images: ['https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=600&auto=format&fit=crop'] },
    { name: 'Wireless Mouse',              sku: 'ELEC-002', cat: 'Electronics',       price: 120,   cost_price: 80,   stock_qty: 60,  description: 'Ergonomic wireless mouse with 2.4GHz connectivity and long battery life.',  images: ['https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=600&auto=format&fit=crop'] },
    { name: 'USB-C Hub 7-in-1',            sku: 'ELEC-003', cat: 'Electronics',       price: 180,   cost_price: 110,  stock_qty: 8,   description: '7-port USB-C hub with HDMI, USB 3.0, SD card reader and PD charging.',     images: ['https://images.unsplash.com/photo-1625895197185-efcec01cffe0?w=600&auto=format&fit=crop'] },
    { name: 'Mechanical Keyboard',         sku: 'ELEC-004', cat: 'Electronics',       price: 350,   cost_price: 220,  stock_qty: 30,  description: 'Tactile mechanical keyboard with RGB backlight and blue switches.',         images: ['https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=600&auto=format&fit=crop'] },
    { name: '27" 4K Monitor',              sku: 'ELEC-005', cat: 'Electronics',       price: 2200,  cost_price: 1700, stock_qty: 12,  description: '27-inch 4K IPS display with 99% sRGB, HDR400 and USB-C input.',            images: ['https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=600&auto=format&fit=crop'] },
    { name: 'Noise-Cancelling Headset',    sku: 'ELEC-006', cat: 'Electronics',       price: 680,   cost_price: 420,  stock_qty: 20,  description: 'Over-ear ANC headset with 30-hour battery and foldable design.',           images: ['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=600&auto=format&fit=crop'] },
    { name: 'Webcam 1080p HD',             sku: 'ELEC-007', cat: 'Electronics',       price: 220,   cost_price: 140,  stock_qty: 35,  description: 'Full HD webcam with built-in stereo mic and auto light correction.',        images: ['https://images.unsplash.com/photo-1611532736597-de2d4265fba3?w=600&auto=format&fit=crop'] },
    { name: 'Portable SSD 1TB',            sku: 'ELEC-008', cat: 'Electronics',       price: 480,   cost_price: 320,  stock_qty: 18,  description: 'Compact USB 3.2 SSD with 1050MB/s read speed and shock resistance.',       images: ['https://images.unsplash.com/photo-1597872200969-2b65d56bd16b?w=600&auto=format&fit=crop'] },
    { name: 'Smart LED Desk Lamp',         sku: 'ELEC-009', cat: 'Electronics',       price: 150,   cost_price: 90,   stock_qty: 50,  description: 'Touch-control LED lamp with 5 colour temps, USB charging port.',           images: ['https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=600&auto=format&fit=crop'] },
    { name: 'Wireless Presenter Remote',   sku: 'ELEC-010', cat: 'Electronics',       price: 95,    cost_price: 55,   stock_qty: 40,  description: 'Plug-and-play wireless presenter with laser pointer, 30m range.',          images: ['https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&auto=format&fit=crop'] },
    // Furniture (8)
    { name: 'Office Chair Ergonomic',      sku: 'FURN-001', cat: 'Furniture',         price: 850,   cost_price: 600,  stock_qty: 40,  description: 'Lumbar-support ergonomic chair with adjustable armrests and mesh back.',  images: ['https://images.unsplash.com/photo-1580480055273-228ff5388ef8?w=600&auto=format&fit=crop'] },
    { name: 'Standing Desk',               sku: 'FURN-002', cat: 'Furniture',         price: 1200,  cost_price: 900,  stock_qty: 15,  description: 'Electric height-adjustable desk, 120×60cm top, memory presets.',          images: ['https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=600&auto=format&fit=crop'] },
    { name: 'Filing Cabinet 4-Drawer',     sku: 'FURN-003', cat: 'Furniture',         price: 620,   cost_price: 420,  stock_qty: 18,  description: 'Steel 4-drawer filing cabinet with central lock and anti-tilt system.',   images: ['https://images.unsplash.com/photo-1558618047-3c8c76ca7d13?w=600&auto=format&fit=crop'] },
    { name: 'Bookshelf 5-Tier',            sku: 'FURN-004', cat: 'Furniture',         price: 380,   cost_price: 240,  stock_qty: 22,  description: 'Solid wood 5-tier bookshelf, 180cm tall, walnut finish.',                 images: ['https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600&auto=format&fit=crop'] },
    { name: 'Conference Table 8-Seater',   sku: 'FURN-005', cat: 'Furniture',         price: 2800,  cost_price: 2000, stock_qty: 5,   description: 'Oval 8-seater conference table with cable management grommets.',          images: ['https://images.unsplash.com/photo-1497366216548-37526070297c?w=600&auto=format&fit=crop'] },
    { name: 'Visitor Chair (Set of 2)',    sku: 'FURN-006', cat: 'Furniture',         price: 420,   cost_price: 280,  stock_qty: 30,  description: 'Padded fabric visitor chairs with chrome legs, set of 2.',                images: ['https://images.unsplash.com/photo-1567538096630-e0c55bd6374c?w=600&auto=format&fit=crop'] },
    { name: 'Reception Desk',              sku: 'FURN-007', cat: 'Furniture',         price: 1800,  cost_price: 1300, stock_qty: 8,   description: 'L-shaped reception desk with built-in storage and cable tray.',           images: ['https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=600&auto=format&fit=crop'] },
    { name: 'Locker Cabinet 6-Door',       sku: 'FURN-008', cat: 'Furniture',         price: 750,   cost_price: 520,  stock_qty: 12,  description: 'Steel 6-door locker cabinet with individual key locks.',                  images: ['https://images.unsplash.com/photo-1595428774223-ef52624120d2?w=600&auto=format&fit=crop'] },
    // Office Supplies (8)
    { name: 'A4 Printer Paper (500 sh)',   sku: 'OFF-001',  cat: 'Office Supplies',   price: 45,    cost_price: 30,   stock_qty: 200, description: 'High-brightness 80gsm A4 copy paper, 500 sheets per ream.',               images: ['https://images.unsplash.com/photo-1568667256549-094345857637?w=600&auto=format&fit=crop'] },
    { name: 'Ballpoint Pens (Box 50)',     sku: 'OFF-002',  cat: 'Office Supplies',   price: 35,    cost_price: 20,   stock_qty: 150, description: 'Smooth-writing blue ballpoint pens, box of 50.',                          images: ['https://images.unsplash.com/photo-1583485088034-697b5bc54ccd?w=600&auto=format&fit=crop'] },
    { name: 'Stapler Heavy Duty',          sku: 'OFF-003',  cat: 'Office Supplies',   price: 85,    cost_price: 55,   stock_qty: 45,  description: 'Heavy-duty stapler, staples up to 50 sheets, includes 1000 staples.',    images: ['https://images.unsplash.com/photo-1618354691373-d851c5c3a990?w=600&auto=format&fit=crop'] },
    { name: 'Whiteboard 120×90cm',         sku: 'OFF-004',  cat: 'Office Supplies',   price: 280,   cost_price: 180,  stock_qty: 20,  description: 'Magnetic dry-erase whiteboard with aluminium frame and pen tray.',        images: ['https://images.unsplash.com/photo-1606326608606-aa0b62935f2b?w=600&auto=format&fit=crop'] },
    { name: 'Sticky Notes Assorted (12pk)',sku: 'OFF-005',  cat: 'Office Supplies',   price: 28,    cost_price: 15,   stock_qty: 300, description: 'Assorted colour sticky notes, 76×76mm, 12 pads of 100 sheets.',          images: ['https://images.unsplash.com/photo-1586281380349-632531db7ed4?w=600&auto=format&fit=crop'] },
    { name: 'Desk Organiser Set',          sku: 'OFF-006',  cat: 'Office Supplies',   price: 65,    cost_price: 40,   stock_qty: 80,  description: '5-piece bamboo desk organiser set with pen holder and file tray.',        images: ['https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=600&auto=format&fit=crop'] },
    { name: 'Laser Printer Toner',         sku: 'OFF-007',  cat: 'Office Supplies',   price: 195,   cost_price: 130,  stock_qty: 35,  description: 'High-yield black toner cartridge, compatible with HP LaserJet series.',  images: ['https://images.unsplash.com/photo-1612815154858-60aa4c59eaa6?w=600&auto=format&fit=crop'] },
    { name: 'Shredder Cross-Cut',          sku: 'OFF-008',  cat: 'Office Supplies',   price: 320,   cost_price: 210,  stock_qty: 15,  description: 'Cross-cut paper shredder, 8-sheet capacity, P-4 security level.',        images: ['https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=600&auto=format&fit=crop'] },
    // Clothing (8)
    { name: 'Corporate Polo Shirt',        sku: 'CLO-001',  cat: 'Clothing',          price: 85,    cost_price: 50,   stock_qty: 100, description: 'Breathable pique polo shirt with embroidered logo option, sizes S–3XL.',  images: ['https://images.unsplash.com/photo-1586790170083-2f9ceadc732d?w=600&auto=format&fit=crop'] },
    { name: 'Safety Work Boots',           sku: 'CLO-002',  cat: 'Clothing',          price: 220,   cost_price: 140,  stock_qty: 45,  description: 'Steel-toe safety boots, slip-resistant sole, sizes 38–46.',               images: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600&auto=format&fit=crop'] },
    { name: 'High-Vis Vest',               sku: 'CLO-003',  cat: 'Clothing',          price: 35,    cost_price: 18,   stock_qty: 120, description: 'EN ISO 20471 Class 2 high-visibility vest with reflective strips.',        images: ['https://images.unsplash.com/photo-1604671801908-6f0c6a092c05?w=600&auto=format&fit=crop'] },
    { name: 'Formal Dress Shirt',          sku: 'CLO-004',  cat: 'Clothing',          price: 120,   cost_price: 75,   stock_qty: 60,  description: 'Slim-fit cotton dress shirt, wrinkle-resistant, sizes S–2XL.',            images: ['https://images.unsplash.com/photo-1620012253295-c15cc3e65df4?w=600&auto=format&fit=crop'] },
    { name: 'Work Trousers',               sku: 'CLO-005',  cat: 'Clothing',          price: 150,   cost_price: 95,   stock_qty: 55,  description: 'Durable multi-pocket work trousers with reinforced knees.',                images: ['https://images.unsplash.com/photo-1473966968600-fa801b869a1a?w=600&auto=format&fit=crop'] },
    { name: 'Fleece Jacket',               sku: 'CLO-006',  cat: 'Clothing',          price: 180,   cost_price: 110,  stock_qty: 40,  description: 'Anti-pill fleece jacket with full zip and two side pockets.',              images: ['https://images.unsplash.com/photo-1591047139829-d91aecb6caea?w=600&auto=format&fit=crop'] },
    { name: 'Branded Cap',                 sku: 'CLO-007',  cat: 'Clothing',          price: 45,    cost_price: 25,   stock_qty: 90,  description: 'Structured 6-panel cap with adjustable strap and embroidery area.',       images: ['https://images.unsplash.com/photo-1588850561407-ed78c282e89b?w=600&auto=format&fit=crop'] },
    { name: 'Disposable Gloves (100pk)',   sku: 'CLO-008',  cat: 'Clothing',          price: 55,    cost_price: 30,   stock_qty: 200, description: 'Powder-free nitrile disposable gloves, box of 100, sizes S–XL.',         images: ['https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=600&auto=format&fit=crop'] },
    // Food & Beverage (8)
    { name: 'Instant Coffee 500g',         sku: 'FB-001',   cat: 'Food & Beverage',   price: 65,    cost_price: 40,   stock_qty: 80,  description: 'Premium freeze-dried instant coffee, rich aroma, 500g tin.',              images: ['https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=600&auto=format&fit=crop'] },
    { name: 'Green Tea Bags (100pk)',       sku: 'FB-002',   cat: 'Food & Beverage',   price: 38,    cost_price: 22,   stock_qty: 120, description: 'Pure green tea bags, individually wrapped, box of 100.',                  images: ['https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=600&auto=format&fit=crop'] },
    { name: 'Mineral Water 1.5L (12pk)',   sku: 'FB-003',   cat: 'Food & Beverage',   price: 48,    cost_price: 28,   stock_qty: 150, description: 'Natural mineral water, 1.5L bottles, case of 12.',                        images: ['https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=600&auto=format&fit=crop'] },
    { name: 'Assorted Biscuits Tin',       sku: 'FB-004',   cat: 'Food & Beverage',   price: 75,    cost_price: 45,   stock_qty: 60,  description: 'Premium assorted biscuit selection tin, 500g, ideal for meetings.',       images: ['https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=600&auto=format&fit=crop'] },
    { name: 'Milo 400g',                   sku: 'FB-005',   cat: 'Food & Beverage',   price: 42,    cost_price: 28,   stock_qty: 90,  description: 'Chocolate malt drink powder, 400g tin, rich in vitamins and minerals.',   images: ['https://images.unsplash.com/photo-1542990253-0d0f5be5f0ed?w=600&auto=format&fit=crop'] },
    { name: 'Fruit Juice 1L (6pk)',        sku: 'FB-006',   cat: 'Food & Beverage',   price: 55,    cost_price: 35,   stock_qty: 70,  description: 'Mixed fruit juice, 100% natural, 1L cartons, pack of 6.',                 images: ['https://images.unsplash.com/photo-1600271886742-f049cd451bba?w=600&auto=format&fit=crop'] },
    { name: 'Sugar 1kg',                   sku: 'FB-007',   cat: 'Food & Beverage',   price: 18,    cost_price: 10,   stock_qty: 200, description: 'Refined white sugar, 1kg pack, ideal for office pantry.',                 images: ['https://images.unsplash.com/photo-1581600140682-d4e68c8cde32?w=600&auto=format&fit=crop'] },
    { name: 'Creamer Whitener 400g',       sku: 'FB-008',   cat: 'Food & Beverage',   price: 32,    cost_price: 20,   stock_qty: 110, description: 'Non-dairy coffee creamer, 400g, dissolves instantly.',                    images: ['https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=600&auto=format&fit=crop'] },
    // Tools & Equipment (8)
    { name: 'Safety Helmet',               sku: 'TOOL-001', cat: 'Tools & Equipment', price: 95,    cost_price: 60,   stock_qty: 7,   description: 'EN 397 certified hard hat with adjustable ratchet suspension.',           images: ['https://images.unsplash.com/photo-1618090584176-7132b9911657?w=600&auto=format&fit=crop'] },
    { name: 'Power Drill Set',             sku: 'TOOL-002', cat: 'Tools & Equipment', price: 480,   cost_price: 310,  stock_qty: 22,  description: '18V cordless drill with 2 batteries, charger and 20-piece bit set.',      images: ['https://images.unsplash.com/photo-1504148455328-c376907d081c?w=600&auto=format&fit=crop'] },
    { name: 'Angle Grinder 115mm',         sku: 'TOOL-003', cat: 'Tools & Equipment', price: 320,   cost_price: 200,  stock_qty: 15,  description: '850W angle grinder with spindle lock and adjustable guard.',               images: ['https://images.unsplash.com/photo-1572981779307-38b8cabb2407?w=600&auto=format&fit=crop'] },
    { name: 'Tool Box 22" Cantilever',     sku: 'TOOL-004', cat: 'Tools & Equipment', price: 185,   cost_price: 115,  stock_qty: 28,  description: '22-inch cantilever tool box with 3 trays and carry handle.',               images: ['https://images.unsplash.com/photo-1581244277943-fe4a9c777189?w=600&auto=format&fit=crop'] },
    { name: 'Measuring Tape 8m',           sku: 'TOOL-005', cat: 'Tools & Equipment', price: 45,    cost_price: 25,   stock_qty: 60,  description: 'Auto-lock 8m measuring tape with magnetic hook and belt clip.',           images: ['https://images.unsplash.com/photo-1609205807107-2d5e9e5e5e5e?w=600&auto=format&fit=crop'] },
    { name: 'Extension Cord 10m (4-way)',  sku: 'TOOL-006', cat: 'Tools & Equipment', price: 120,   cost_price: 75,   stock_qty: 40,  description: '4-socket extension cord, 10m, surge-protected with individual switches.', images: ['https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&auto=format&fit=crop'] },
    { name: 'Ladder Aluminium 6-Step',     sku: 'TOOL-007', cat: 'Tools & Equipment', price: 380,   cost_price: 240,  stock_qty: 10,  description: 'Lightweight aluminium step ladder, 150kg rated, non-slip feet.',          images: ['https://images.unsplash.com/photo-1601584115197-04ecc0da31d7?w=600&auto=format&fit=crop'] },
    { name: 'Fire Extinguisher 2kg',       sku: 'TOOL-008', cat: 'Tools & Equipment', price: 210,   cost_price: 135,  stock_qty: 25,  description: 'ABC dry powder fire extinguisher, 2kg, wall bracket included.',           images: ['https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=600&auto=format&fit=crop'] },
  ];
  const productMap = {};
  for (const p of productDefs) {
    const prod = await Product.findOneAndUpdate(
      { tenant_id: tenant._id, sku: p.sku },
      { ...p, tenant_id: tenant._id, branch_id: branch._id, category_id: catMap[p.cat], low_stock_threshold: 10 },
      { upsert: true, new: true },
    );
    productMap[p.sku] = prod;
  }

  // ── Chart of Accounts ──────────────────────────────────────────────────────
  await seedChartOfAccounts(tenant._id);

  // ── Suppliers ──────────────────────────────────────────────────────────────
  const supplierDefs = [
    { name: 'TechDistrib Ltd',      email: 'supply@techdistrib.com',   phone: '+233201234567', payment_terms: 'Net 30' },
    { name: 'OfficeWorld Ghana',    email: 'orders@officeworld.gh',    phone: '+233209876543', payment_terms: 'Net 15' },
    { name: 'FurniCraft Accra',     email: 'sales@furnicraft.com.gh',  phone: '+233244112233', payment_terms: 'Net 45' },
    { name: 'ProTools Supplies',    email: 'info@protools.gh',         phone: '+233277445566', payment_terms: 'Net 30' },
  ];
  for (const s of supplierDefs) {
    await Supplier.findOneAndUpdate({ tenant_id: tenant._id, email: s.email }, { ...s, tenant_id: tenant._id }, { upsert: true });
  }

  // ── Customers ──────────────────────────────────────────────────────────────
  const customerDefs = [
    { name: 'Akosua Frimpong',   email: 'akosua@email.com',    phone: '+233244000001', company: 'Frimpong & Sons' },
    { name: 'Nana Brew',         email: 'nana@email.com',      phone: '+233244000002', company: 'Brew Enterprises' },
    { name: 'Kofi Acheampong',   email: 'kofi.a@email.com',    phone: '+233244000003', company: 'Acheampong Tech' },
    { name: 'Efua Sarpong',      email: 'efua@email.com',      phone: '+233244000004', company: 'Sarpong Retail' },
    { name: 'Kwabena Osei',      email: 'kwabena@email.com',   phone: '+233244000005', company: 'Osei Logistics' },
    { name: 'Adwoa Mensah',      email: 'adwoa@email.com',     phone: '+233244000006', company: 'Mensah Imports' },
    { name: 'Fiifi Quaye',       email: 'fiifi@email.com',     phone: '+233244000007', company: 'Quaye & Co' },
    { name: 'Abena Asare',       email: 'abena.a@email.com',   phone: '+233244000008', company: 'Asare Holdings' },
    { name: 'Yaw Boateng',       email: 'yaw.b@email.com',     phone: '+233244000009', company: 'Boateng Ventures' },
    { name: 'Esi Darko',         email: 'esi@email.com',       phone: '+233244000010', company: 'Darko Solutions' },
  ];
  const customerMap = {};
  for (const c of customerDefs) {
    const cust = await Customer.findOneAndUpdate({ tenant_id: tenant._id, email: c.email }, { ...c, tenant_id: tenant._id }, { upsert: true, new: true });
    customerMap[c.email] = cust;
  }
  const customers = Object.values(customerMap);

  // ── Orders (6 months of data) ──────────────────────────────────────────────
  const allProducts = Object.values(productMap);
  let orderCounter = await Order.countDocuments();

  const makeOrder = async (monthsBack, dayOfMonth, payStatus = 'paid') => {
    orderCounter++;
    const num = `ORD-${String(orderCounter).padStart(4, '0')}`;
    const exists = await Order.findOne({ order_number: num });
    if (exists) return;

    const cust = pick(customers);
    const numItems = rand(1, 3);
    const items = [];
    const usedSkus = new Set();
    for (let i = 0; i < numItems; i++) {
      const prod = pick(allProducts);
      if (usedSkus.has(prod.sku)) continue;
      usedSkus.add(prod.sku);
      const qty = rand(1, 4);
      items.push({
        product_id: prod._id,
        product_name: prod.name,
        quantity: qty,
        unit_price: prod.price,
        total: qty * prod.price,
      });
    }
    const subtotal = items.reduce((s, i) => s + i.total, 0);
    const tax = parseFloat((subtotal * 0.15).toFixed(2));
    const total = subtotal + tax;
    const orderDate = monthsAgo(monthsBack, dayOfMonth);

    await Order.create({
      tenant_id: tenant._id,
      branch_id: branch._id,
      order_number: num,
      customer_id: cust._id,
      customer_name: cust.name,
      customer_email: cust.email,
      customer_phone: cust.phone,
      subtotal,
      tax_amount: tax,
      total,
      payment_status: payStatus,
      payment_method: pick(['card', 'mobile_money']),
      status: payStatus === 'paid' ? pick(['delivered', 'shipped', 'processing']) : 'pending',
      source: pick(['storefront', 'internal']),
      items,
      created_by: salesUser._id,
      createdAt: orderDate,
      updatedAt: orderDate,
    });
  };

  // Spread ~60 paid orders across last 6 months + a few pending
  const monthDistrib = [
    { m: 5, count: 6 },
    { m: 4, count: 9 },
    { m: 3, count: 11 },
    { m: 2, count: 13 },
    { m: 1, count: 12 },
    { m: 0, count: 10 },
  ];
  for (const { m, count } of monthDistrib) {
    for (let i = 0; i < count; i++) {
      await makeOrder(m, rand(1, 28), 'paid');
    }
  }
  // A few pending/failed for realism
  for (let i = 0; i < 5; i++) await makeOrder(0, rand(1, 10), 'pending');
  for (let i = 0; i < 2; i++) await makeOrder(0, rand(1, 5), 'failed');

  // ── Employees ──────────────────────────────────────────────────────────────
  const employeeDefs = [
    { code: 'EMP-001', name: 'Kwame Asante',    dept: 'Sales',           title: 'Sales Executive',       salary: 3200, userEmail: 'sales@gthink.com' },
    { code: 'EMP-002', name: 'Abena Mensah',    dept: 'Warehouse',       title: 'Warehouse Supervisor',  salary: 2800, userEmail: 'warehouse@gthink.com' },
    { code: 'EMP-003', name: 'Kofi Boateng',    dept: 'Finance',         title: 'Accountant',            salary: 3500, userEmail: 'accounts@gthink.com' },
    { code: 'EMP-004', name: 'Ama Owusu',       dept: 'Human Resources', title: 'HR Manager',            salary: 4000, userEmail: 'hr@gthink.com' },
    { code: 'EMP-005', name: 'Yaw Darko',       dept: 'Procurement',     title: 'Procurement Officer',   salary: 3000, userEmail: 'procurement@gthink.com' },
    { code: 'EMP-006', name: 'Adjoa Tetteh',    dept: 'Sales',           title: 'Sales Representative',  salary: 2600, userEmail: null },
    { code: 'EMP-007', name: 'Kojo Amponsah',   dept: 'IT',              title: 'IT Support',            salary: 3800, userEmail: null },
    { code: 'EMP-008', name: 'Akua Bonsu',      dept: 'Administration',  title: 'Admin Assistant',       salary: 2400, userEmail: null },
    { code: 'EMP-009', name: 'Nii Armah',       dept: 'Warehouse',       title: 'Stock Controller',      salary: 2700, userEmail: null },
    { code: 'EMP-010', name: 'Maame Serwaa',    dept: 'Finance',         title: 'Finance Analyst',       salary: 3300, userEmail: null },
    { code: 'EMP-011', name: 'Kweku Asiedu',    dept: 'Sales',           title: 'Sales Manager',         salary: 5000, userEmail: null },
    { code: 'EMP-012', name: 'Esi Nyarko',      dept: 'Procurement',     title: 'Procurement Analyst',   salary: 2900, userEmail: null },
  ];
  for (const e of employeeDefs) {
    const linkedUser = e.userEmail ? await User.findOne({ email: e.userEmail }) : null;
    await Employee.findOneAndUpdate(
      { tenant_id: tenant._id, employee_code: e.code },
      {
        tenant_id: tenant._id,
        employee_code: e.code,
        name: e.name,
        email: e.userEmail || `${e.code.toLowerCase()}@gthink.com`,
        user_id: linkedUser?._id || null,
        department_id: deptMap[e.dept],
        job_title: e.title,
        gross_salary: e.salary,
        start_date: daysAgo(rand(180, 900)),
        status: 'active',
      },
      { upsert: true },
    );
  }

  // ── Leads ──────────────────────────────────────────────────────────────────
  const stages = ['new', 'contacted', 'qualified', 'proposal', 'negotiation'];
  const leadTitles = [
    'Bulk Laptop Order', 'Office Furniture Setup', 'Annual Stationery Contract',
    'IT Equipment Refresh', 'Warehouse Shelving Project', 'Corporate Uniform Supply',
    'Catering Equipment Deal', 'Security Tools Procurement', 'New Branch Setup',
    'School Lab Equipment',
  ];
  for (let i = 0; i < leadTitles.length; i++) {
    const cust = customers[i % customers.length];
    await Lead.findOneAndUpdate(
      { tenant_id: tenant._id, title: leadTitles[i] },
      {
        tenant_id: tenant._id,
        title: leadTitles[i],
        customer_id: cust._id,
        stage: stages[i % stages.length],
        value: rand(5000, 80000),
        assigned_to: salesUser._id,
        next_followup: daysAgo(-rand(1, 14)),
      },
      { upsert: true },
    );
  }

  // ── Expenses ───────────────────────────────────────────────────────────────
  const expenseAccount = await Account.findOne({ tenant_id: tenant._id, code: '5200' });
  const rentAccount    = await Account.findOne({ tenant_id: tenant._id, code: '5300' });
  const expenseDefs = [
    // This month
    { title: 'Office Rent – Current Month',  cat: 'Rent',       amount: 4500,  account: rentAccount,    daysBack: 2 },
    { title: 'Electricity Bill',             cat: 'Utilities',  amount: 820,   account: rentAccount,    daysBack: 5 },
    { title: 'Internet & Phone',             cat: 'Utilities',  amount: 350,   account: expenseAccount, daysBack: 7 },
    { title: 'Office Cleaning Service',      cat: 'Services',   amount: 280,   account: expenseAccount, daysBack: 10 },
    { title: 'Printer Ink & Toner',          cat: 'Supplies',   amount: 195,   account: expenseAccount, daysBack: 12 },
    { title: 'Staff Refreshments',           cat: 'Welfare',    amount: 450,   account: expenseAccount, daysBack: 15 },
    // Last month
    { title: 'Office Rent – Last Month',     cat: 'Rent',       amount: 4500,  account: rentAccount,    daysBack: 35 },
    { title: 'Water Bill',                   cat: 'Utilities',  amount: 210,   account: rentAccount,    daysBack: 38 },
    { title: 'Marketing Materials',          cat: 'Marketing',  amount: 1200,  account: expenseAccount, daysBack: 42 },
    { title: 'Vehicle Fuel',                 cat: 'Transport',  amount: 680,   account: expenseAccount, daysBack: 45 },
    { title: 'Software Subscriptions',       cat: 'IT',         amount: 520,   account: expenseAccount, daysBack: 50 },
    // 2 months ago
    { title: 'Office Rent – 2 Months Ago',   cat: 'Rent',       amount: 4500,  account: rentAccount,    daysBack: 65 },
    { title: 'Team Building Event',          cat: 'Welfare',    amount: 2200,  account: expenseAccount, daysBack: 70 },
    { title: 'Equipment Maintenance',        cat: 'Maintenance',amount: 950,   account: expenseAccount, daysBack: 75 },
  ];
  for (const e of expenseDefs) {
    await Expense.findOneAndUpdate(
      { tenant_id: tenant._id, title: e.title },
      {
        tenant_id: tenant._id,
        title: e.title,
        category: e.cat,
        amount: e.amount,
        account_id: e.account?._id,
        expense_date: daysAgo(e.daysBack),
        created_by: adminUser._id,
      },
      { upsert: true },
    );
  }

  // ── Purchase Orders ────────────────────────────────────────────────────────
  const suppliers = await Supplier.find();
  const allProds  = Object.values(productMap);
  const procUser  = await User.findOne({ email: 'procurement@gthink.com' });

  const poDefs = [
    { supplier: 0, status: 'approved',            daysBack: 3,  items: [{ prod: 'ELEC-001', qty: 5,  cost: 2800 }, { prod: 'ELEC-002', qty: 20, cost: 80 }] },
    { supplier: 1, status: 'approved',            daysBack: 6,  items: [{ prod: 'OFF-001',  qty: 50, cost: 30  }, { prod: 'OFF-002',  qty: 30, cost: 20 }] },
    { supplier: 2, status: 'sent',                daysBack: 10, items: [{ prod: 'FURN-001', qty: 10, cost: 600 }, { prod: 'FURN-002', qty: 4,  cost: 900 }] },
    { supplier: 3, status: 'sent',                daysBack: 14, items: [{ prod: 'TOOL-001', qty: 15, cost: 60  }, { prod: 'TOOL-002', qty: 8,  cost: 310 }] },
    { supplier: 0, status: 'partially_received',  daysBack: 20, items: [{ prod: 'ELEC-004', qty: 10, cost: 220 }, { prod: 'ELEC-005', qty: 3,  cost: 1700}] },
    { supplier: 1, status: 'partially_received',  daysBack: 25, items: [{ prod: 'OFF-003',  qty: 20, cost: 55  }] },
    { supplier: 2, status: 'completed',           daysBack: 40, items: [{ prod: 'FURN-003', qty: 6,  cost: 420 }] },
    { supplier: 3, status: 'completed',           daysBack: 50, items: [{ prod: 'ELEC-006', qty: 8,  cost: 420 }] },
  ];

  for (let i = 0; i < poDefs.length; i++) {
    const def = poDefs[i];
    const poNum = `PO-SEED-${String(i+1).padStart(3,'0')}`;
    const exists = await PurchaseOrder.findOne({ po_number: poNum });
    if (exists) continue;
    const sup = suppliers[def.supplier % suppliers.length];
    let total_cost = 0;
    const items = [];
    for (const it of def.items) {
      const prod = productMap[it.prod];
      if (!prod) continue;
      const itemTotal = it.qty * it.cost;
      total_cost += itemTotal;
      items.push({ product_id: prod._id, product_name: prod.name, quantity_ordered: it.qty, quantity_received: def.status === 'completed' ? it.qty : def.status === 'partially_received' ? Math.floor(it.qty/2) : 0, unit_cost: it.cost, total: itemTotal });
    }
    const poDate = daysAgo(def.daysBack);
    await PurchaseOrder.create({ tenant_id: tenant._id, branch_id: branch._id, po_number: poNum, supplier_id: sup._id, total_cost, status: def.status, items, created_by: procUser._id, approved_by: adminUser._id, approved_at: poDate, expected_date: daysAgo(def.daysBack - 7), createdAt: poDate, updatedAt: poDate });
  }

  // ── Attendance (last 14 working days) ──────────────────────────────────────
  const allEmployees = await Employee.find();
  const attStatuses = ['present','present','present','present','present','absent','half_day'];
  for (let d = 13; d >= 0; d--) {
    const date = daysAgo(d);
    const dow = date.getDay();
    if (dow === 0 || dow === 6) continue;
    for (const emp of allEmployees) {
      const dayStart = new Date(date); dayStart.setHours(0,0,0,0);
      const dayEnd   = new Date(date); dayEnd.setHours(23,59,59,999);
      const exists = await Attendance.findOne({ employee_id: emp._id, date: { $gte: dayStart, $lt: dayEnd } });
      if (exists) continue;
      await Attendance.create({ tenant_id: tenant._id, employee_id: emp._id, date: dayStart, status: pick(attStatuses) });
    }
  }

  // ── Leave Requests ──────────────────────────────────────────────────────────
  const leaveDefs = [
    { emp: 'EMP-001', type: 'annual',    start: 5,  end: 3,  reason: 'Family vacation',     status: 'approved' },
    { emp: 'EMP-003', type: 'sick',      start: 2,  end: 1,  reason: 'Medical appointment', status: 'approved' },
    { emp: 'EMP-006', type: 'annual',    start: 10, end: 7,  reason: 'Personal leave',      status: 'pending'  },
    { emp: 'EMP-009', type: 'sick',      start: 1,  end: 0,  reason: 'Not feeling well',    status: 'pending'  },
    { emp: 'EMP-004', type: 'maternity', start: 30, end: 0,  reason: 'Maternity leave',     status: 'approved' },
    { emp: 'EMP-007', type: 'unpaid',    start: 15, end: 12, reason: 'Personal reasons',    status: 'rejected' },
  ];
  for (const l of leaveDefs) {
    const emp = await Employee.findOne({ employee_code: l.emp });
    if (!emp) continue;
    const exists = await LeaveRequest.findOne({ employee_id: emp._id, leave_type: l.type, start_date: daysAgo(l.start) });
    if (exists) continue;
    await LeaveRequest.create({ tenant_id: tenant._id, employee_id: emp._id, leave_type: l.type, start_date: daysAgo(l.start), end_date: daysAgo(l.end), reason: l.reason, status: l.status, reviewed_by: l.status !== 'pending' ? adminUser._id : undefined });
  }

  // ── Journal Entries (seed balanced GL entries) ────────────────────────────
  const accMap = {};
  const allAccounts = await Account.find({ tenant_id: tenant._id });
  for (const a of allAccounts) accMap[a.code] = a;

  // Get real totals scoped to this tenant
  const tid = tenant._id;
  const [revAgg, expAgg, arAgg, invAgg, apAgg] = await Promise.all([
    Order.aggregate([{ $match: { tenant_id: tid, payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' }, subtotal: { $sum: '$subtotal' } } }]),
    Expense.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Order.aggregate([{ $match: { tenant_id: tid, payment_status: 'pending' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Product.aggregate([{ $match: { tenant_id: tid, is_active: true } }, { $group: { _id: null, total: { $sum: { $multiply: ['$cost_price', '$stock_qty'] } } } }]),
    PurchaseOrder.aggregate([{ $match: { tenant_id: tid, status: { $in: ['approved','sent','partially_received'] } } }, { $group: { _id: null, total: { $sum: '$total_cost' } } }]),
  ]);

  const totalRevenue   = revAgg[0]?.total    || 0;
  const totalCogs      = revAgg[0]?.subtotal || 0;
  const totalExpenses  = expAgg[0]?.total    || 0;
  const totalAR        = arAgg[0]?.total     || 0;
  const totalInventory = invAgg[0]?.total    || 0;
  const totalAP        = apAgg[0]?.total     || 0;

  // Cash = revenue collected minus expenses paid minus a portion of COGS already paid
  const cashBalance = Math.max(0, totalRevenue - totalExpenses - totalCogs * 0.3);
  // Equity = Assets - Liabilities  (must equal for BS to balance)
  const equity = cashBalance + totalAR + totalInventory - totalAP;

  // ── JE-SEED-001: Sales & balance sheet positions ───────────────────────────
  // Debits:  Cash + AR + Inventory + COGS
  // Credits: Sales Revenue + AP + Owner's Equity
  // For balance: Cash + AR + Inventory + COGS = Revenue + AP + Equity
  //   equity = Cash + AR + Inventory - AP  →  Cash + AR + Inventory + COGS = Revenue + AP + (Cash + AR + Inventory - AP) + COGS - Revenue
  // Simplify: both sides equal Cash + AR + Inventory + COGS  ✓ (equity absorbs the difference)
  const je1Debits  = cashBalance + totalAR + totalInventory + totalCogs;
  const je1Credits = totalRevenue + totalAP + equity;
  // Floating-point safety: adjust equity line to make it exactly balanced
  const je1EquityAdj = equity + (je1Debits - je1Credits);

  // ── JE-SEED-002: Expense recognition ──────────────────────────────────────
  // Debits:  Expense accounts (5200 + 5300 + 5100)
  // Credits: Cash (already reduced above, so we credit equity to keep GL clean)
  // We credit Owner's Equity for the expense offset so cash isn't double-counted
  const expRent   = parseFloat((totalExpenses * 0.4).toFixed(2));
  const expOffice = parseFloat((totalExpenses * 0.4).toFixed(2));
  const expSal    = parseFloat((totalExpenses - expRent - expOffice).toFixed(2)); // remainder
  const je2Total  = expRent + expOffice + expSal;

  const postJe = async (ref, desc, lines) => {
    const exists = await JournalEntry.findOne({ reference: ref });
    if (exists) return;
    const mapped = lines
      .filter(l => accMap[l.code] && Math.abs(l.debit - 0) + Math.abs(l.credit - 0) > 0.001)
      .map(l => ({ account_id: accMap[l.code]._id, debit: parseFloat(l.debit.toFixed(2)), credit: parseFloat(l.credit.toFixed(2)), description: desc }));
    const td = parseFloat(mapped.reduce((s, l) => s + l.debit,  0).toFixed(2));
    const tc = parseFloat(mapped.reduce((s, l) => s + l.credit, 0).toFixed(2));
    if (Math.abs(td - tc) > 0.02) {
      console.warn(`⚠️  Skipping unbalanced seed entry ${ref}: debits=${td} credits=${tc}`);
      return;
    }
    await JournalEntry.create({ tenant_id: tid, reference: ref, description: desc, total_debit: td, total_credit: tc, lines: mapped, source: 'manual', created_by: adminUser._id, status: 'posted' });
  };

  await postJe('JE-SEED-001', 'Opening balances — sales, AR, inventory & equity', [
    { code: '1001', debit: cashBalance,    credit: 0 },           // Cash & Bank
    { code: '1110', debit: totalAR,        credit: 0 },           // Accounts Receivable
    { code: '1120', debit: totalInventory, credit: 0 },           // Inventory
    { code: '5001', debit: totalCogs,      credit: 0 },           // COGS
    { code: '4001', debit: 0,              credit: totalRevenue }, // Sales Revenue
    { code: '2001', debit: 0,              credit: totalAP },      // Accounts Payable
    { code: '3001', debit: 0,              credit: je1EquityAdj }, // Owner's Equity (balancing)
  ]);

  await postJe('JE-SEED-002', 'Operating expenses recognition', [
    { code: '5300', debit: expRent,   credit: 0 },        // Rent & Utilities
    { code: '5200', debit: expOffice, credit: 0 },        // Office Expenses
    { code: '5100', debit: expSal,    credit: 0 },        // Salaries & Wages
    { code: '3001', debit: 0,         credit: je2Total }, // Offset to equity (cash already seeded net)
  ]);

  const { PaymentLog } = require('../models');
  await PaymentLog.deleteMany({ tenant_id: tenant._id });

  const paymentMethods = ['paystack', 'cash', 'mobile_money', 'bank_transfer', 'card'];
  const storefrontCustomers = [
    { name: 'Akosua Frimpong', email: 'akosua@email.com' },
    { name: 'Nana Brew',       email: 'nana@email.com' },
    { name: 'Kofi Acheampong', email: 'kofi.a@email.com' },
    { name: 'Efua Sarpong',    email: 'efua@email.com' },
    { name: 'Kwabena Osei',    email: 'kwabena@email.com' },
  ];

  // Storefront payments (last 3 months)
  for (let i = 0; i < 20; i++) {
    const cust = pick(storefrontCustomers);
    const amount = rand(80, 4500);
    const dBack = rand(0, 90);
    await PaymentLog.create({
      tenant_id: tenant._id,
      source: 'storefront',
      reference: `ORD-SF-${String(i+1).padStart(4,'0')}`,
      amount,
      currency: 'GHS',
      method: pick(['paystack', 'mobile_money', 'card']),
      status: pick(['success','success','success','failed']),
      payer_name: cust.name,
      payer_email: cust.email,
      description: `Storefront order payment`,
      recorded_by: adminUser._id,
      createdAt: daysAgo(dBack),
      updatedAt: daysAgo(dBack),
    });
  }

  // POS payments (last 2 months)
  const posCustomers = ['Walk-in Customer', 'Kofi Mensah', 'Ama Boateng', 'Yaw Asante', 'Efua Darko'];
  for (let i = 0; i < 15; i++) {
    const amount = rand(30, 800);
    const dBack = rand(0, 60);
    await PaymentLog.create({
      tenant_id: tenant._id,
      source: 'pos',
      reference: `POS-${Date.now()}-${i}`,
      amount,
      currency: 'GHS',
      method: pick(['cash', 'mobile_money', 'card']),
      status: 'success',
      payer_name: pick(posCustomers),
      description: `POS sale`,
      recorded_by: salesUser._id,
      createdAt: daysAgo(dBack),
      updatedAt: daysAgo(dBack),
    });
  }

  // Internal orders (last 2 months)
  for (let i = 0; i < 10; i++) {
    const cust = pick(customers);
    const amount = rand(500, 8000);
    const dBack = rand(0, 60);
    await PaymentLog.create({
      tenant_id: tenant._id,
      source: 'internal_order',
      reference: `ORD-INT-${String(i+1).padStart(4,'0')}`,
      amount,
      currency: 'GHS',
      method: pick(['bank_transfer', 'card', 'mobile_money']),
      status: pick(['success','success','pending']),
      payer_name: cust.name,
      payer_email: cust.email,
      description: `Internal order payment`,
      recorded_by: salesUser._id,
      createdAt: daysAgo(dBack),
      updatedAt: daysAgo(dBack),
    });
  }

  // Purchase order payments
  const poPayments = [
    { ref: 'PO-SEED-007', amount: 2520,  supplier: 'FurniCraft Accra',  dBack: 38 },
    { ref: 'PO-SEED-008', amount: 3360,  supplier: 'ProTools Supplies', dBack: 48 },
  ];
  for (const p of poPayments) {
    await PaymentLog.create({
      tenant_id: tenant._id,
      source: 'purchase_order',
      reference: p.ref,
      amount: p.amount,
      currency: 'GHS',
      method: 'bank_transfer',
      status: 'success',
      payer_name: p.supplier,
      description: `Purchase order ${p.ref} paid`,
      recorded_by: adminUser._id,
      createdAt: daysAgo(p.dBack),
      updatedAt: daysAgo(p.dBack),
    });
  }

  // Payroll payments (last 3 months)
  const payrollEmps = [
    { name: 'Kwame Asante',  amount: 3200 },
    { name: 'Abena Mensah',  amount: 2800 },
    { name: 'Kofi Boateng',  amount: 3500 },
    { name: 'Ama Owusu',     amount: 4000 },
    { name: 'Yaw Darko',     amount: 3000 },
  ];
  for (let m = 1; m <= 3; m++) {
    for (const emp of payrollEmps) {
      const dBack = m * 30 + rand(0, 5);
      await PaymentLog.create({
        tenant_id: tenant._id,
        source: 'payroll',
        reference: `PAYROLL-${emp.name.replace(' ','-')}-M${m}`,
        amount: emp.amount,
        currency: 'GHS',
        method: 'bank_transfer',
        status: 'success',
        payer_name: emp.name,
        description: `Payroll payment — Month ${m}`,
        recorded_by: adminUser._id,
        createdAt: daysAgo(dBack),
        updatedAt: daysAgo(dBack),
      });
    }
  }

  console.log('✅ Database seeded successfully!');
  console.log('\n👤 Login Credentials:');
  console.log('\n  --- Platform Admin (GTHINK) ---');
  console.log('   Platform Admin → admin@gthink.com        / Admin@1234');
  console.log('\n  --- Demo Business (GEMS Store) ---');
  console.log('   Business Owner → owner@gems-store.com   / Admin@1234');
  console.log('   Sales Staff    → sales@gthink.com       / Staff@1234');
  console.log('   Warehouse      → warehouse@gthink.com   / Staff@1234');
  console.log('   Accountant     → accounts@gthink.com    / Staff@1234');
  console.log('   HR Manager     → hr@gthink.com          / Staff@1234');
  console.log('   Procurement    → procurement@gthink.com / Staff@1234');
  console.log('\n  --- Storefront ---');
  console.log('   Visit: http://localhost:3000/store/gems-store');
  process.exit(0);
};

seed().catch(err => { console.error('❌ Seeding failed:', err.message); process.exit(1); });
