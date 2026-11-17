# -*- coding: utf-8 -*-
"""Проверяет .xlsx, собранный кодом расширения, независимым читателем (openpyxl)."""
import sys

from openpyxl import load_workbook

path = sys.argv[1] if len(sys.argv) > 1 else "sample-report.xlsx"
wb = load_workbook(path)
print("sheets:", wb.sheetnames)

ws = wb["Операции"]
print("Операции:", ws.dimensions, "max_row:", ws.max_row)
print("header:", [c.value for c in ws[1]])
print("first:", [c.value for c in ws[2]])
print("second:", [c.value for c in ws[3]])

# типы ячеек: дата должна читаться как datetime, деньги — как число
date_cell = ws.cell(row=2, column=2)
money_cell = ws.cell(row=2, column=9)
print("date cell:", repr(date_cell.value), date_cell.number_format)
print("money cell:", repr(money_cell.value), money_cell.number_format)
assert hasattr(date_cell.value, "year"), "дата не распознана как дата"
assert isinstance(money_cell.value, (int, float)), "сумма не число"

# колонка «Карта / счёт» заполнена в каждой строке
accounts = [row[11] for row in ws.iter_rows(min_row=2, values_only=True)]
assert all(isinstance(value, str) and value.strip() for value in accounts), "пустая карта/счёт"
print("account values:", sorted(set(accounts)))

# пересчитываем итоги из листа «Операции» (в итоги идут только «Проведено»/«Холд»)
OK_STATUSES = {"Проведено", "Холд"}
totals = {"Расход": 0.0, "trOut": 0.0, "trIn": 0.0, "Доход": 0.0}
cashback = 0.0
for row in ws.iter_rows(min_row=2, values_only=True):
    kind = row[6]
    direction = row[7]
    amount = row[8]
    status = row[12]
    if status not in OK_STATUSES:
        continue
    if isinstance(amount, (int, float)):
        if kind == "Расход":
            totals["Расход"] += amount
        elif kind == "Доход":
            totals["Доход"] += amount
        elif kind in ("Перевод", "Перевод между счетами"):
            # Направление берём из отдельной колонки, а не угадываем по типу.
            totals["trIn" if direction == "Поступление" else "trOut"] += amount
    if isinstance(row[10], (int, float)):
        cashback += row[10]

print("recomputed:", {k: round(v, 2) for k, v in totals.items()}, "cashback:", round(cashback, 2))

s = wb["Сводка"]
summary = {}
for row in s.iter_rows(min_row=1, max_col=2):
    label = row[0].value
    if isinstance(label, str) and row[1].value is not None:
        summary[label] = row[1].value

print("summary KPI:", summary)

checks = [
    ("Расходы (покупки и услуги), ₽", round(totals["Расход"], 2)),
    ("Переводы исходящие, ₽", round(totals["trOut"], 2)),
    ("Переводы входящие, ₽", round(totals["trIn"], 2)),
    ("Поступления (доходы), ₽", round(totals["Доход"], 2)),
    ("Кешбэк начислено, баллы", round(cashback, 2)),
]
for label, expected in checks:
    actual = summary.get(label)
    ok = actual is not None and abs(actual - expected) < 0.011
    print(("OK  " if ok else "FAIL"), label, "expected", expected, "actual", actual)
    assert ok, f"расхождение в «{label}»: {actual} != {expected}"

print("ALL CHECKS PASSED")
