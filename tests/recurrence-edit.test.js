const assert = require('node:assert/strict');
const { buildRecurringRowsForEdit, getRecurringDateForMonth } = require('../recurrence');
const { repetitionShouldCreate } = require('../app');

function run() {
  const rows = buildRecurringRowsForEdit(
    'despesa',
    'Internet',
    79.9,
    '14/06/2026',
    'monthly',
    1,
    3,
    'Conta Corrente',
    'Casa'
  );

  assert.equal(rows.length, 3, 'Deve gerar 3 parcelas mensais quando converter uma transação única');
  assert.equal(rows[0][1], 'Internet (1 / 3)', 'A primeira parcela deve receber a notação de recorrência');
  assert.equal(rows[1][0], '14/07/2026', 'A segunda parcela deve ser criada para o mês seguinte');
  assert.equal(rows[2][0], '14/08/2026', 'A terceira parcela deve ser criada para o próximo mês');

  assert.equal(getRecurringDateForMonth('14/06/2026', 2026, 7), '14/07/2026', 'Deve avançar para o mês seguinte ao criar uma recorrência em um mês futuro');
  assert.equal(getRecurringDateForMonth('14/06/2026', 2026, 8), '14/08/2026', 'Deve continuar avançando um mês por vez');
  assert.equal(getRecurringDateForMonth('14/12/2025', 2026, 1), '14/01/2026', 'Deve respeitar o ano alvo quando a recorrência for criada no próximo ano');

  const repetition = {
    description: 'Empréstimo mãe',
    value: -450,
    category: 'Transferência',
    account: 'C6 Mãe',
    period: 'mensal',
    start: '10/09/2026',
    end: '10/08/2030',
  };

  assert.equal(repetitionShouldCreate(repetition, 2026, 8), true, 'Deve criar a parcela no mês anterior ao início quando o registro é feito um mês antes do start');
  assert.equal(repetitionShouldCreate(repetition, 2026, 9), true, 'Deve criar a parcela no mês de início');
  assert.equal(repetitionShouldCreate(repetition, 2026, 7), false, 'Não deve criar antes do mês anterior ao início');
}

try {
  run();
  console.log('OK: recorrência ao converter transação única');
} catch (error) {
  console.error('FALHA:', error.message);
  process.exitCode = 1;
}
