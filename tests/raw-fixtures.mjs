// Сырые операции GraphQL для тестов: форма повторяет реальный ответ банка.

export function rawItem(overrides = {}) {
  const base = {
    id: 'id-1',
    date: '2026-01-10T12:00:00.000Z',
    direction: 'DEBIT',
    title: { plain: 'Магазин' },
    description: 'Супермаркеты',
    statusCode: 'CLEAR',
    rightSubTitle: null,
    summaryCashback: null,
    amount: { money: { amount: '100.00', currency: 'RUB' }, plus: null },
  };
  const merged = { ...base, ...overrides };
  if (overrides.amount !== undefined) {
    merged.amount = { money: null, plus: null, ...overrides.amount };
  }
  return merged;
}
