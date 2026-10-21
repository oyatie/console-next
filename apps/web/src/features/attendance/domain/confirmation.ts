/** An acknowledgement belongs to one exact person, date, value and optimistic base. */
export const confirmationKey = (cell: { employee_id: string; work_date: string; value: string; base_entry_id?: string | null }) => JSON.stringify([cell.employee_id, cell.work_date, cell.value, cell.base_entry_id ?? null]);
