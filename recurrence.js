(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.buildRecurringRowsForEdit = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function addMonths(dateStr, n) {
    const d = new Date(dateStr.split('/').reverse().join('-'));
    d.setMonth(d.getMonth() + n);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${d.getFullYear()}`;
  }

  function installmentDescription(base, current, total) {
    return `${base} (${current} / ${total})`;
  }

  function buildRecurringRowsForEdit(type, desc, amount, dateSheet, installType, installX, installY, account, category, sourceAccount, destAccount) {
    const isTransfer = type === 'transferencia';
    const sign = type === 'despesa' ? -1 : 1;

    if (installType !== 'monthly') {
      if (isTransfer) {
        return [
          [dateSheet, desc, -amount, 'Transferência', sourceAccount],
          [dateSheet, desc, amount, 'Transferência', destAccount],
        ];
      }
      return [[dateSheet, desc, sign * amount, category, account]];
    }

    const rows = [];
    for (let i = installX; i <= installY; i++) {
      const installDate = addMonths(dateSheet, i - installX);
      const installDesc = installmentDescription(desc, i, installY);
      if (isTransfer) {
        rows.push([installDate, installDesc, -amount, 'Transferência', sourceAccount]);
        rows.push([installDate, installDesc, amount, 'Transferência', destAccount]);
      } else {
        rows.push([installDate, installDesc, sign * amount, category, account]);
      }
    }

    return rows;
  }

  return { buildRecurringRowsForEdit };
});
