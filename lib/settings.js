const { DEFAULT_CRATE_SETTINGS } = require('../db-init');

function normalizeCrateSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const crateWeightKg = Number(source.crateWeightKg);
    return {
        crateWeightKg: Number.isFinite(crateWeightKg) && crateWeightKg > 0
            ? crateWeightKg
            : DEFAULT_CRATE_SETTINGS.crateWeightKg,
    };
}

async function getCrateSettings(db) {
    const row = await db('app_settings').where({ setting_key: 'crate_settings' }).first();
    if (!row || !row.value_json) {
        return { ...DEFAULT_CRATE_SETTINGS };
    }
    try {
        return normalizeCrateSettings(JSON.parse(row.value_json));
    } catch (_) {
        return { ...DEFAULT_CRATE_SETTINGS };
    }
}

async function saveCrateSettings(db, nextSettings, updatedBy) {
    const normalized = normalizeCrateSettings(nextSettings);
    const existing = await db('app_settings').where({ setting_key: 'crate_settings' }).first();
    const payload = {
        value_json: JSON.stringify(normalized),
        updated_by: updatedBy || null,
        updated_at: db.fn.now(),
    };

    if (existing) {
        await db('app_settings').where({ setting_key: 'crate_settings' }).update(payload);
    } else {
        await db('app_settings').insert({ setting_key: 'crate_settings', ...payload });
    }

    return normalized;
}

module.exports = {
    getCrateSettings,
    saveCrateSettings,
    normalizeCrateSettings,
};
