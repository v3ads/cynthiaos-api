// The sole category-baseline price configuration for the public Fast adapter.
// Explicitly confirmed by the user on 2026-10-21 for the public Fast selector.
// These are category baselines, independent of per-unit discounts/market rents.
// No staff/admin write route is provided for pricing by this feature.
export const FAST_BASELINE_MONTHLY_USD:Readonly<Record<string,number>>=Object.freeze({
 'basic/furnished':2240,'basic/unfurnished':1990,
 'upgraded/furnished':2370,'upgraded/unfurnished':2020,
 'premium/furnished':2570,'premium/unfurnished':2220,
});
