const DEFAULT_CRATE_SETTINGS = { crateWeightKg: 1.8 };

async function initSchema(db) {
    const hasRequests = await db.schema.hasTable('despatch_requests');
    if (!hasRequests) {
        await db.schema.createTable('despatch_requests', (table) => {
            table.increments('id').primary();
            table.string('labels_requested_by', 150).notNullable();
            table.string('labels_applied_by', 150).nullable();
            table.string('labels_printed_by', 150).notNullable();
            table.string('customer_name', 200).notNullable();
            table.string('customer_reference_no', 150).nullable();
            table.string('airway_bill_no', 100).nullable();
            table.date('request_date').notNullable();
            table.string('status', 20).notNullable().defaultTo('OPEN');
            table.timestamp('created_at').defaultTo(db.fn.now());
            table.timestamp('updated_at').defaultTo(db.fn.now());
        });
    }

    const hasLines = await db.schema.hasTable('despatch_lines');
    if (!hasLines) {
        await db.schema.createTable('despatch_lines', (table) => {
            table.increments('id').primary();
            table.integer('despatch_request_id').unsigned().notNullable()
                .references('id').inTable('despatch_requests').onDelete('CASCADE');
            table.integer('line_no').notNullable().defaultTo(1);
            table.string('carton_no', 30).notNullable();
            table.string('product_description', 255).notNullable();
            table.decimal('gross_weight_kg', 10, 2).notNullable();
            table.integer('crate_count').notNullable().defaultTo(1);
            table.decimal('crate_weight_kg', 6, 2).notNullable();
            table.decimal('net_weight_kg', 10, 2).notNullable();
            table.date('production_date').nullable();
            table.date('expiry_date').nullable();
            table.timestamp('created_at').defaultTo(db.fn.now());
        });
    }

    const hasSettings = await db.schema.hasTable('app_settings');
    if (!hasSettings) {
        await db.schema.createTable('app_settings', (table) => {
            table.string('setting_key', 100).primary();
            table.text('value_json').notNullable();
            table.string('updated_by', 150).nullable();
            table.timestamp('updated_at').defaultTo(db.fn.now());
        });
    }

    const cratesRow = await db('app_settings').where({ setting_key: 'crate_settings' }).first();
    if (!cratesRow) {
        await db('app_settings').insert({
            setting_key: 'crate_settings',
            value_json: JSON.stringify(DEFAULT_CRATE_SETTINGS),
            updated_by: null,
            updated_at: db.fn.now(),
        });
    }
}

module.exports = {
    initSchema,
    DEFAULT_CRATE_SETTINGS,
};
