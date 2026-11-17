# -*- coding: utf-8 -*-
"""Независимая проверка .xlsx, собранного расширением, читателем openpyxl.

Проверяет не только типы ячеек, но и весь расчёт: KPI, месяцы, категории и
доли. Сравнение идёт в целых копейках, допуска нет: расхождение на 0.01 ₽
обязано проваливать проверку.

Использование:
    python tests/verify.py [<отчёт.xlsx> [expected.json]]

Без пути проверяет tests/fixtures/sample-report.xlsx (образец отчёта в репозитории).
Без expected.json сверяет сводку с пересчётом из листа «Операции» (self-check).
С expected.json дополнительно сравнивает значения с ручными ожиданиями фикстуры.
"""
import json
import re
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from openpyxl import load_workbook

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

OK_STATUSES = {"Проведено", "Холд"}
MONTHS = {"янв": 1, "фев": 2, "мар": 3, "апр": 4, "май": 5, "июн": 6,
          "июл": 7, "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12}
HEADER = [
    "№", "Дата", "Время", "Месяц", "Описание", "Категория", "Тип", "Направление",
    "Сумма, ₽", "Баллы", "Кешбэк, баллы", "Карта / счёт", "Статус", "ID операции",
]
KPI_LABELS = {
    "Расходы (покупки и услуги), ₽": "exp",
    "Переводы исходящие, ₽": "trOut",
    "Всего списаний, ₽": "totalOut",
    "Поступления (доходы), ₽": "inc",
    "Переводы входящие, ₽": "trIn",
    "Кешбэк начислено, баллы": "cb",
    "Списано баллов": "pointsSpent",
    "Начислено баллов": "pointsEarned",
}


def fail(message):
    raise AssertionError(message)


def kopecks(value, where=""):
    """Денежное значение ячейки -> целые копейки (или None)."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(f"{where}: ожидалось число, получено {value!r}")
    return int((Decimal(str(value)) * 100).to_integral_value(rounding=ROUND_HALF_UP))


def read_operations(worksheet):
    header = [cell.value for cell in worksheet[1]]
    if header != HEADER:
        fail(f"неожиданная шапка «Операции»: {header}")
    column = {name: index for index, name in enumerate(header)}
    operations = []
    for values in worksheet.iter_rows(min_row=2, values_only=True):
        if all(value is None for value in values):
            continue
        date_cell = values[column["Дата"]]
        operations.append({
            "n": values[column["№"]],
            "date": date_cell.date().isoformat() if hasattr(date_cell, "date") else str(date_cell),
            "kind": values[column["Тип"]],
            "direction": values[column["Направление"]],
            "amountKopecks": kopecks(values[column["Сумма, ₽"]], "Сумма"),
            "month": values[column["Месяц"]],
            "category": values[column["Категория"]],
            "account": values[column["Карта / счёт"]],
            "status": values[column["Статус"]],
            "pointsKopecks": kopecks(values[column["Баллы"]], "Баллы"),
            "cashbackKopecks": kopecks(values[column["Кешбэк, баллы"]], "Кешбэк"),
        })
    return operations


def month_key(label):
    match = re.match(r"^([а-я]{3}) (\d{4})$", str(label))
    if not match:
        return None
    return f"{match.group(2)}-{MONTHS[match.group(1)]:02d}"


def read_summary(worksheet):
    kpi = {}
    months = []
    categories = []
    totals = None
    in_categories = False
    for row in worksheet.iter_rows(values_only=True):
        if not row or all(value is None for value in row):
            continue
        label = row[0]
        if label == "Категории расходов (без переводов)":
            in_categories = True
            continue
        if in_categories:
            if label in ("Категория", None) or (label is None and row[1] is None):
                continue
            if label == "Итого":
                continue
            if isinstance(label, str) and row[1] is not None:
                categories.append({
                    "name": label,
                    "amountKopecks": kopecks(row[1], "Категория"),
                    "n": row[2],
                    "share": Decimal(str(row[3] or 0)),
                })
            continue
        if label == "Итого":
            totals = {
                "n": row[4],
                "exp": kopecks(row[5], "Итого расходы"),
                "trOut": kopecks(row[6], "Итого переводы"),
                "inc": kopecks(row[7], "Итого поступления"),
                "cb": kopecks(row[8], "Итого кешбэк"),
            }
            continue
        # Строка месяца идёт параллельно KPI: месяц и KPI одной строки собираем оба.
        if len(row) > 8 and month_key(row[3]) and row[4] is not None:
            months.append({
                "label": row[3],
                "key": month_key(row[3]),
                "n": row[4],
                "exp": kopecks(row[5], "Месяц расходы"),
                "trOut": kopecks(row[6], "Месяц переводы"),
                "inc": kopecks(row[7], "Месяц поступления"),
                "cb": kopecks(row[8], "Месяц кешбэк"),
            })
        if isinstance(label, str) and label in KPI_LABELS and row[1] is not None:
            kpi[KPI_LABELS[label]] = kopecks(row[1], label)
            continue
    return kpi, months, categories, totals


def recompute(operations):
    ok = [row for row in operations if row["status"] in OK_STATUSES]
    kpi = {"exp": 0, "trOut": 0, "trIn": 0, "inc": 0, "cb": 0,
           "pointsSpent": 0, "pointsEarned": 0}
    months = {}
    categories = {}
    for row in ok:
        bucket = months.setdefault(
            row["month"], {"n": 0, "exp": 0, "trOut": 0, "trIn": 0, "inc": 0, "cb": 0}
        )
        bucket["n"] += 1
        amount = row["amountKopecks"]
        if row["kind"] == "Расход" and amount is not None:
            kpi["exp"] += amount
            bucket["exp"] += amount
            entry = categories.setdefault(row["category"] or "(без категории)", {"amount": 0, "n": 0})
            entry["amount"] += amount
            entry["n"] += 1
        elif row["kind"] in ("Перевод", "Перевод между счетами") and amount is not None:
            if row["direction"] == "Поступление":
                kpi["trIn"] += amount
                bucket["trIn"] += amount
            else:
                kpi["trOut"] += amount
                bucket["trOut"] += amount
        elif row["kind"] == "Доход" and amount is not None:
            kpi["inc"] += amount
            bucket["inc"] += amount
        if row["cashbackKopecks"]:
            kpi["cb"] += row["cashbackKopecks"]
            bucket["cb"] += row["cashbackKopecks"]
        if row["pointsKopecks"]:
            if row["pointsKopecks"] < 0:
                kpi["pointsSpent"] += -row["pointsKopecks"]
            else:
                kpi["pointsEarned"] += row["pointsKopecks"]
    kpi["totalOut"] = kpi["exp"] + kpi["trOut"]
    return ok, kpi, months, categories


def compare_self_check(operations, kpi, months, categories, totals):
    ok, expected_kpi, expected_months, expected_categories = recompute(operations)
    for key, expected in expected_kpi.items():
        actual = kpi.get(key)
        if actual != expected:
            fail(f"KPI «{key}»: в сводке {actual}, пересчёт {expected} (копейки)")
    if len(months) != len(expected_months):
        fail(f"месяцев в сводке {len(months)}, пересчёт {len(expected_months)}")
    for entry in months:
        expected = expected_months.get(entry["key"])
        if expected is None:
            fail(f"в сводке лишний месяц {entry['label']}")
        for field in ("n", "exp", "trOut", "inc", "cb"):
            if entry[field] != expected[field]:
                fail(f"месяц {entry['label']} {field}: {entry[field]} != {expected[field]}")
    expected_names = sorted(expected_categories, key=lambda name: (-expected_categories[name]["amount"], name))
    actual_names = [entry["name"] for entry in categories]
    if actual_names != expected_names:
        fail(f"категории: {actual_names} != {expected_names}")
    for entry in categories:
        expected = expected_categories[entry["name"]]
        if entry["amountKopecks"] != expected["amount"] or entry["n"] != expected["n"]:
            fail(f"категория {entry['name']}: {entry} != {expected}")
        share = Decimal(entry["amountKopecks"]) / Decimal(kpi["exp"]) if kpi["exp"] else Decimal(0)
        if abs(entry["share"] - share) > Decimal("1e-9"):
            fail(f"доля {entry['name']}: {entry['share']} != {share}")
    if totals is None:
        fail("в сводке нет строки «Итого»")
    if totals["n"] != len(ok):
        fail(f"«Итого» операций: {totals['n']} != {len(ok)}")
    for field, key in (("exp", "exp"), ("trOut", "trOut"), ("inc", "inc"), ("cb", "cb")):
        if totals[field] != expected_kpi[key]:
            fail(f"«Итого» {field}: {totals[field]} != {expected_kpi[key]}")


def compare_expected(operations, kpi, months, categories, expected):
    expected_operations = expected.get("operations", [])
    if len(operations) != len(expected_operations):
        fail(f"строк в отчёте {len(operations)}, в ожиданиях {len(expected_operations)}")
    for actual, wanted in zip(operations, expected_operations):
        for field, value in wanted.items():
            if actual.get(field) != value:
                fail(f"строка {wanted.get('n')} поле {field}: {actual.get(field)!r} != {value!r}")
    for label, value in expected.get("kpiKopecks", {}).items():
        key = KPI_LABELS[label]
        if kpi.get(key) != value:
            fail(f"KPI «{label}»: {kpi.get(key)} != {value} (копейки)")
    expected_months = expected.get("months", [])
    if len(months) != len(expected_months):
        fail(f"месяцев {len(months)}, в ожиданиях {len(expected_months)}")
    for actual, wanted in zip(months, expected_months):
        if actual["label"] != wanted["label"]:
            fail(f"месяц: {actual['label']} != {wanted['label']}")
        for field in ("n", "exp", "trOut", "inc", "cb"):
            if actual[field] != wanted[field]:
                fail(f"месяц {wanted['label']} {field}: {actual[field]} != {wanted[field]}")
    expected_categories = expected.get("categories", [])
    if [entry["name"] for entry in categories] != [entry["name"] for entry in expected_categories]:
        fail("порядок/состав категорий не совпал с ожиданиями")
    for actual, wanted in zip(categories, expected_categories):
        if actual["amountKopecks"] != wanted["amountKopecks"] or actual["n"] != wanted["n"]:
            fail(f"категория {wanted['name']}: {actual} != {wanted}")


def main():
    default_report = Path(__file__).resolve().parent / "fixtures" / "sample-report.xlsx"
    report_arg = sys.argv[1] if len(sys.argv) > 1 else None
    path = Path(report_arg) if report_arg else default_report
    expected_path = Path(sys.argv[2]) if len(sys.argv) > 2 else None

    if not path.exists():
        fail(f"нет файла {path}; укажите путь: python tests/verify.py <отчёт.xlsx>")

    workbook = load_workbook(path)
    if workbook.sheetnames != ["Операции", "Сводка"]:
        fail(f"листы: {workbook.sheetnames}")

    operations_ws = workbook["Операции"]
    operations = read_operations(operations_ws)
    kpi, months, categories, totals = read_summary(workbook["Сводка"])

    # Типы ячеек: дата — настоящая дата, деньги — числа.
    date_cell = operations_ws.cell(row=2, column=2)
    if not hasattr(date_cell.value, "year"):
        fail("дата не распознана как дата")
    if not isinstance(operations_ws.cell(row=2, column=9).value, (int, float)):
        fail("сумма не число")

    print(f"файл: {path}")
    print(f"операций: {len(operations)}; листы: {workbook.sheetnames}")

    compare_self_check(operations, kpi, months, categories, totals)
    print("self-check: сводка совпадает с пересчётом из «Операции»")

    if expected_path:
        expected = json.loads(expected_path.read_text(encoding="utf-8"))
        compare_expected(operations, kpi, months, categories, expected)
        print(f"ожидания: совпали с {expected_path}")

    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as error:
        print("FAIL:", error)
        sys.exit(1)
