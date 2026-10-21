// The routes and Home load the change record, the change list and the apply consequence from here.
import { changeQuery as query } from "./api";
import { EffectuateConsequence as Consequence } from "./ui/effectuate-consequence";
import { OrgChange as Record } from "./ui/org-change-record";
import { OrgChanges as List } from "./ui/org-changes";

export const OrgChange = Record;
export const OrgChanges = List;
export const EffectuateConsequence = Consequence;
export const changeQuery = query;
