const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── USER ─────────────────────────────────────────────────────────────────────
const userSchema = new Schema({
  name:          { type: String, required: true },
  email:         { type: String, required: true, unique: true, lowercase: true },
  password_hash: { type: String, required: true },
  role:          { type: String, enum: ['super_admin','sales_staff','warehouse_staff','accountant','hr_manager','procurement_officer'], default: 'sales_staff' },
  is_active:     { type: Boolean, default: true },
  token_version: { type: Number, default: 0 },
}, { timestamps: true });

// ── CATEGORY ─────────────────────────────────────────────────────────────────
const categorySchema = new Schema({
  name:        { type: String, required: true, unique: true },
  description: String,
}, { timestamps: true });

// ── PRODUCT ──────────────────────────────────────────────────────────────────
const productSchema = new Schema({
  name:                { type: String, required: true },
  sku:                 { type: String, required: true, unique: true },
  description:         String,
  category_id:         { type: Schema.Types.ObjectId, ref: 'Category' },
  price:               { type: Number, required: true, default: 0 },
  compare_price:       { type: Number, default: 0 },
  cost_price:          { type: Number, default: 0 },
  stock_qty:           { type: Number, default: 0 },
  low_stock_threshold: { type: Number, default: 10 },
  unit:                { type: String, default: 'piece' },
  images:              [String],
  is_active:           { type: Boolean, default: true },
  created_by:          { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// ── STOCK MOVEMENT ────────────────────────────────────────────────────────────
const stockMovementSchema = new Schema({
  product_id: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  type:       { type: String, enum: ['sale','purchase','adjustment','return'], required: true },
  quantity:   { type: Number, required: true },
  reference:  String,
  notes:      String,
  created_by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// ── CUSTOMER ──────────────────────────────────────────────────────────────────
const customerSchema = new Schema({
  name:       { type: String, required: true },
  email:      String,
  phone:      String,
  company:    String,
  address:    String,
  segment:    { type: String, default: 'general' },
  notes:      String,
  created_by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// ── LEAD ──────────────────────────────────────────────────────────────────────
const leadSchema = new Schema({
  customer_id:   { type: Schema.Types.ObjectId, ref: 'Customer' },
  title:         { type: String, required: true },
  stage:         { type: String, enum: ['new','contacted','qualified','proposal','negotiation','won','lost'], default: 'new' },
  value:         { type: Number, default: 0 },
  assigned_to:   { type: Schema.Types.ObjectId, ref: 'User' },
  next_followup: Date,
  notes:         String,
}, { timestamps: true });

// ── CONTACT HISTORY ───────────────────────────────────────────────────────────
const contactHistorySchema = new Schema({
  customer_id:  { type: Schema.Types.ObjectId, ref: 'Customer' },
  type:         { type: String, enum: ['call','email','meeting','whatsapp','other'], default: 'call' },
  notes:        String,
  contact_date: { type: Date, default: Date.now },
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// ── ORDER ─────────────────────────────────────────────────────────────────────
const orderItemSchema = new Schema({
  product_id:   { type: Schema.Types.ObjectId, ref: 'Product' },
  product_name: { type: String, required: true },
  quantity:     { type: Number, required: true },
  unit_price:   { type: Number, required: true },
  total:        { type: Number, required: true },
});

const orderSchema = new Schema({
  order_number:    { type: String, required: true, unique: true },
  customer_id:     { type: Schema.Types.ObjectId, ref: 'Customer' },
  customer_name:   { type: String, required: true },
  customer_email:  String,
  customer_phone:  String,
  delivery_address:String,
  subtotal:        { type: Number, default: 0 },
  tax_amount:      { type: Number, default: 0 },
  total:           { type: Number, default: 0 },
  payment_ref:     String,
  payment_method:  String,
  payment_status:  { type: String, enum: ['pending','paid','failed','refunded'], default: 'pending' },
  status:          { type: String, enum: ['pending','processing','shipped','delivered','cancelled'], default: 'pending' },
  source:          { type: String, enum: ['storefront','internal','pos'], default: 'storefront' },
  items:           [orderItemSchema],
  created_by:      { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// ── SUPPLIER ──────────────────────────────────────────────────────────────────
const supplierSchema = new Schema({
  name:          { type: String, required: true },
  email:         String,
  phone:         String,
  address:       String,
  payment_terms: String,
  notes:         String,
  is_active:     { type: Boolean, default: true },
}, { timestamps: true });

// ── PURCHASE ORDER ────────────────────────────────────────────────────────────
const poItemSchema = new Schema({
  product_id:        { type: Schema.Types.ObjectId, ref: 'Product' },
  product_name:      { type: String, required: true },
  quantity_ordered:  { type: Number, required: true },
  quantity_received: { type: Number, default: 0 },
  unit_cost:         { type: Number, required: true },
  total:             { type: Number, required: true },
});

const purchaseOrderSchema = new Schema({
  po_number:     { type: String, required: true, unique: true },
  supplier_id:   { type: Schema.Types.ObjectId, ref: 'Supplier' },
  total_cost:    { type: Number, default: 0 },
  status:        { type: String, enum: ['draft','pending_approval','approved','sent','partially_received','completed','cancelled'], default: 'draft' },
  notes:         String,
  expected_date: Date,
  items:         [poItemSchema],
  created_by:    { type: Schema.Types.ObjectId, ref: 'User' },
  approved_by:   { type: Schema.Types.ObjectId, ref: 'User' },
  approved_at:   Date,
}, { timestamps: true });

// ── ACCOUNT ───────────────────────────────────────────────────────────────────
const accountSchema = new Schema({
  code:        { type: String, required: true, unique: true },
  name:        { type: String, required: true },
  type:        { type: String, enum: ['asset','liability','equity','revenue','expense'], required: true },
  balance:     { type: Number, default: 0 },
  description: String,
  is_active:   { type: Boolean, default: true },
}, { timestamps: true });

// ── JOURNAL ENTRY ─────────────────────────────────────────────────────────────
const journalLineSchema = new Schema({
  account_id:  { type: Schema.Types.ObjectId, ref: 'Account' },
  debit:       { type: Number, default: 0 },
  credit:      { type: Number, default: 0 },
  description: String,
});

const journalEntrySchema = new Schema({
  reference:    { type: String, required: true, unique: true },
  description:  { type: String, required: true },
  total_debit:  { type: Number, default: 0 },
  total_credit: { type: Number, default: 0 },
  source:       { type: String, enum: ['manual','sale','purchase','payroll'], default: 'manual' },
  source_id:    Schema.Types.ObjectId,
  entry_date:   { type: Date, default: Date.now },
  lines:        [journalLineSchema],
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// ── EXPENSE ───────────────────────────────────────────────────────────────────
const expenseSchema = new Schema({
  title:        { type: String, required: true },
  category:     String,
  amount:       { type: Number, required: true },
  account_id:   { type: Schema.Types.ObjectId, ref: 'Account' },
  description:  String,
  expense_date: { type: Date, default: Date.now },
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// ── DEPARTMENT ────────────────────────────────────────────────────────────────
const departmentSchema = new Schema({
  name:        { type: String, required: true, unique: true },
  description: String,
}, { timestamps: true });

// ── EMPLOYEE ──────────────────────────────────────────────────────────────────
const employeeSchema = new Schema({
  user_id:       { type: Schema.Types.ObjectId, ref: 'User' },
  employee_code: { type: String, required: true, unique: true },
  name:          { type: String, required: true },
  email:         String,
  phone:         String,
  department_id: { type: Schema.Types.ObjectId, ref: 'Department' },
  job_title:     String,
  gross_salary:  { type: Number, required: true, default: 0 },
  start_date:    Date,
  status:        { type: String, enum: ['active','on_leave','terminated'], default: 'active' },
}, { timestamps: true });

// ── ATTENDANCE ────────────────────────────────────────────────────────────────
const attendanceSchema = new Schema({
  employee_id: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  date:        { type: Date, required: true },
  status:      { type: String, enum: ['present','absent','half_day','leave'], default: 'present' },
  notes:       String,
}, { timestamps: true });
attendanceSchema.index({ employee_id: 1, date: 1 }, { unique: true });

// ── LEAVE REQUEST ─────────────────────────────────────────────────────────────
const leaveRequestSchema = new Schema({
  employee_id: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  leave_type:  { type: String, default: 'annual' },
  start_date:  { type: Date, required: true },
  end_date:    { type: Date, required: true },
  reason:      String,
  status:      { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  reviewed_by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// ── PAYROLL RUN ───────────────────────────────────────────────────────────────
const payrollRunSchema = new Schema({
  employee_id:  { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  month:        { type: Number, required: true },
  year:         { type: Number, required: true },
  gross_salary: { type: Number, required: true },
  allowances:   { type: Number, default: 0 },
  deductions:   { type: Number, default: 0 },
  net_salary:   { type: Number, required: true },
  status:       { type: String, enum: ['draft','submitted','approved','paid'], default: 'submitted' },
  approved_by:  { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
payrollRunSchema.index({ employee_id: 1, month: 1, year: 1 }, { unique: true });

// ── STOREFRONT CART ──────────────────────────────────────────────────────────
const cartItemSchema = new Schema({
  product_id:   { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  product_name: String,
  price:        Number,
  quantity:     { type: Number, required: true, min: 1 },
  images:       [String],
  category_name:String,
  stock_qty:    Number,
  low_stock_threshold: Number,
  sku:          String,
});

const cartSchema = new Schema({
  cart_id:  { type: String, required: true, unique: true },
  items:    [cartItemSchema],
  expires_at: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

// ── TAX RATE ──────────────────────────────────────────────────────────────────
const taxRateSchema = new Schema({
  name:       { type: String, required: true },
  rate:       { type: Number, required: true },
  applies_to: { type: String, enum: ['sales','purchases','both'], default: 'both' },
  is_active:  { type: Boolean, default: true },
}, { timestamps: true });

// Add id + created_at/updated_at aliases to all schemas
const allSchemas = [
  userSchema, categorySchema, productSchema, stockMovementSchema,
  customerSchema, leadSchema, contactHistorySchema, orderSchema,
  supplierSchema, purchaseOrderSchema, accountSchema, journalEntrySchema,
  expenseSchema, departmentSchema, employeeSchema, attendanceSchema,
  leaveRequestSchema, payrollRunSchema, taxRateSchema, cartSchema,
];
allSchemas.forEach(schema => {
  schema.set('toJSON', {
    virtuals: true,
    transform: (_, ret) => {
      ret.id = ret._id;
      ret.created_at = ret.createdAt;
      ret.updated_at = ret.updatedAt;
      return ret;
    },
  });
});

module.exports = {
  User:           mongoose.model('User', userSchema),
  Category:       mongoose.model('Category', categorySchema),
  Product:        mongoose.model('Product', productSchema),
  StockMovement:  mongoose.model('StockMovement', stockMovementSchema),
  Customer:       mongoose.model('Customer', customerSchema),
  Lead:           mongoose.model('Lead', leadSchema),
  ContactHistory: mongoose.model('ContactHistory', contactHistorySchema),
  Order:          mongoose.model('Order', orderSchema),
  Supplier:       mongoose.model('Supplier', supplierSchema),
  PurchaseOrder:  mongoose.model('PurchaseOrder', purchaseOrderSchema),
  Account:        mongoose.model('Account', accountSchema),
  JournalEntry:   mongoose.model('JournalEntry', journalEntrySchema),
  Expense:        mongoose.model('Expense', expenseSchema),
  Department:     mongoose.model('Department', departmentSchema),
  Employee:       mongoose.model('Employee', employeeSchema),
  Attendance:     mongoose.model('Attendance', attendanceSchema),
  LeaveRequest:   mongoose.model('LeaveRequest', leaveRequestSchema),
  PayrollRun:     mongoose.model('PayrollRun', payrollRunSchema),
  TaxRate:        mongoose.model('TaxRate', taxRateSchema),
  Cart:           mongoose.model('Cart', cartSchema),
};
