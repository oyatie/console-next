/** The company-domain invariant shared by sign-in and platform assignment. */
const DOMAIN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const validCompanyDomain = (domain: string) => DOMAIN.test(domain);
