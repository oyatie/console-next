// SPDX-License-Identifier: LicenseRef-Proprietary
import raw from "./saeon-universe.json";
import { maskRrn, padDigits, syntheticInvalidRrn } from "./saeon-ids";

export type SaeonGradeCode = keyof typeof raw.grades;
export type SaeonRoleCode = keyof typeof raw.roles;
export type SaeonEmploymentTypeCode = keyof typeof raw.employmentTypes;
export type SaeonMissingCode = keyof typeof raw.missingLabels;

interface SaeonWorkplace {
  id: string;
  name: string;
  headOffice: boolean;
  brn: string;
  brnFormatted: string;
  departments: readonly string[];
}

export interface SaeonEntity {
  id: string;
  prefix: string;
  name: string;
  headcount: number;
  crn: string;
  crnFormatted: string;
  workplaces: readonly SaeonWorkplace[];
}

export interface SaeonRosterRow {
  seq: number;
  id: string;
  employeeNumber: string;
  name: string;
  entityId: string;
  entityName: string;
  workplaceId: string;
  place: string;
  gradeCode: SaeonGradeCode;
  gradeLabel: string;
  roleCode: SaeonRoleCode | null;
  roleLabel: string;
  employmentTypeCode: SaeonEmploymentTypeCode;
  employmentTypeLabel: string;
  hireDate: string;
  birthDate: string;
  rrn: string;
  rrnMasked: string;
  missingCode: SaeonMissingCode | null;
  missingLabel: string;
}

const GRADE_ORDER: readonly SaeonGradeCode[] = [
  "STAFF",
  "SENIOR_STAFF",
  "ASSISTANT_MANAGER",
  "MANAGER",
  "DEPUTY_GM",
  "GENERAL_MANAGER",
];

function deterministicBirthDate(seed: number): string {
  const year = 1968 + (seed % 34);
  const month = padDigits(((seed * 5) % 12) + 1, 2);
  const day = padDigits(((seed * 7) % 28) + 1, 2);
  return `${year}-${month}-${day}`;
}

function deterministicHireDate(seed: number): string {
  const year = 2009 + (seed % 18);
  const month = padDigits(((seed * 3) % 11) + 1, 2);
  const day = padDigits(((seed * 11) % 27) + 1, 2);
  return `${year}-${month}-${day}`;
}

function buildGeneratedSlice(
  count: number,
  surnames: readonly string[],
  startOffset: number,
  reservedNumbers: ReadonlySet<string>,
  entities: readonly SaeonEntity[],
) {
  const { givenNames } = raw.namePools;
  const names = Array.from({ length: count }, (_, idx) => {
    const surname = surnames[idx % surnames.length]!;
    const given = givenNames[Math.floor(idx / surnames.length) % givenNames.length]!;
    return `${surname}${given}`;
  }).sort((a, b) => a.localeCompare(b, "ko"));

  let serialCursor = 700 + startOffset;
  return names.map((name, idx) => {
    const seed = startOffset + idx + 1;
    const entity = entities[seed % entities.length]!;
    let employeeNumber = `${entity.prefix}${padDigits(((serialCursor++) % 9000) + 1000, 4)}`;
    while (reservedNumbers.has(employeeNumber)) {
      employeeNumber = `${entity.prefix}${padDigits(((serialCursor++) % 9000) + 1000, 4)}`;
    }
    const site = entity.workplaces[seed % entity.workplaces.length]!;
    const dept = site.departments.length > 0 ? site.departments[seed % site.departments.length] : undefined;
    const place = dept ? `${site.name} › ${dept}` : site.name;
    const gradeCode = GRADE_ORDER[seed % GRADE_ORDER.length]!;
    const employmentTypeCode: SaeonEmploymentTypeCode =
      seed % 19 === 0 ? "PART_TIME" : seed % 7 === 0 ? "CONTRACT" : "REGULAR";
    const missingCode: SaeonMissingCode | null = seed % 6 === 0 ? "ADDRESS" : null;
    const birthDate = deterministicBirthDate(seed);
    const genderDigit = (Number(birthDate.slice(0, 4)) >= 2000
      ? seed % 2 === 0 ? 3 : 4
      : seed % 2 === 0 ? 1 : 2) as 1 | 2 | 3 | 4;
    return {
      name,
      employeeNumber,
      entity,
      workplaceId: site.id,
      place,
      gradeCode,
      roleCode: null as SaeonRoleCode | null,
      employmentTypeCode,
      hireDate: deterministicHireDate(seed),
      birthDate,
      rrn: syntheticInvalidRrn(birthDate, genderDigit, seed + 2000),
      missingCode,
    };
  });
}

export function buildSaeonRoster(
  entities: readonly SaeonEntity[],
  hero: { employeeNumber: string; birthDate: string; rrn: string },
): readonly SaeonRosterRow[] {
  const reserved = new Set<string>(raw.rosterWindow.map(row => row.employeeNumber));
  const before = buildGeneratedSlice(1277, raw.namePools.surnamesBeforeWindow, 0, reserved, entities);
  for (const row of before) reserved.add(row.employeeNumber);
  const after = buildGeneratedSlice(2054 - 1299, raw.namePools.surnamesAfterWindow, 2000, reserved, entities);

  const windowRows = raw.rosterWindow.map((row, idx) => {
    const entity = entities[row.entityIndex]!;
    const siteName = row.place.split(" › ")[0]!;
    const site = entity.workplaces.find(w => w.name === siteName) ?? entity.workplaces[0]!;
    const isHero = row.employeeNumber === hero.employeeNumber;
    const birthDate = isHero ? hero.birthDate : deterministicBirthDate(1278 + idx);
    const rrn = isHero ? hero.rrn : syntheticInvalidRrn(birthDate, (idx % 2 === 0 ? 2 : 1) as 1 | 2, 5000 + idx);
    return {
      name: row.name,
      employeeNumber: row.employeeNumber,
      entity,
      workplaceId: site.id,
      place: row.place,
      gradeCode: row.gradeCode as SaeonGradeCode,
      roleCode: row.roleCode as SaeonRoleCode | null,
      employmentTypeCode: row.employmentTypeCode as SaeonEmploymentTypeCode,
      hireDate: row.hireDate,
      birthDate,
      rrn,
      missingCode: row.missingCode as SaeonMissingCode | null,
    };
  });

  return [...before, ...windowRows, ...after].map((item, index) => {
    const seq = index + 1;
    return {
      seq,
      id: `00000000-0000-4000-8300-${padDigits(seq, 12)}`,
      employeeNumber: item.employeeNumber,
      name: item.name,
      entityId: item.entity.id,
      entityName: item.entity.name,
      workplaceId: item.workplaceId,
      place: item.place,
      gradeCode: item.gradeCode,
      gradeLabel: raw.grades[item.gradeCode],
      roleCode: item.roleCode,
      roleLabel: item.roleCode ? raw.roles[item.roleCode] : "",
      employmentTypeCode: item.employmentTypeCode,
      employmentTypeLabel: raw.employmentTypes[item.employmentTypeCode],
      hireDate: item.hireDate,
      birthDate: item.birthDate,
      rrn: item.rrn,
      rrnMasked: maskRrn(item.rrn),
      missingCode: item.missingCode,
      missingLabel: item.missingCode ? raw.missingLabels[item.missingCode] : "",
    };
  });
}
