// BW-13 leave facts: every leave names its type, and childcare leave (Equal Employment Act Art. 19) and maternity leave (Labor Standards Act Art. 74)
// also their expected return. The server refuses the same (leave_type_required, leave_return_date_required).
export const RETURN_REQUIRED = ["CHILDCARE", "MATERNITY"] as const;
export const returnRequired = (type: string | null) => (RETURN_REQUIRED as readonly string[]).includes(type ?? "");
