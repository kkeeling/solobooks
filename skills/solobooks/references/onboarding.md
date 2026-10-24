# Onboarding a new person

Goal: from a fresh install to a first draft invoice in one conversation, with no forms. Ask in plain words, a few things at a time, and write each answer into solobooks as soon as you have it. Everything you don't ask about starts with a working default: invoices wait for the person's click before they go out, expenses use Schedule C categories, and time is entered by hand or by you.

## 0. Make sure it's installed

Run `solobooks doctor`. If it fails, fix what it says (usually `solobooks setup`) before going on. If the solobooks MCP tools aren't in your tool list yet, use the CLI for all of onboarding. Don't ask the person to restart their agent app now; that would end this conversation partway through. The restart comes at the end (see Finish).

## How to ask

If your app has a tool for asking the person questions, use it for every question below. In Claude Code that is AskUserQuestion, which takes up to four questions per call. Give real options wherever they exist (net 15 or net 30, hourly or retainer, details you already know from this machine or the conversation). For a free-text answer such as a name or an address, don't pad with placeholders like "I'll type it"; the free-text answer is always there, so offer only options that mean something, such as "Skip for now". Go straight from one step to the next without asking whether to carry on. In an app without such a tool, ask in plain chat.

## The five things to ask for

### 1. Install

Done when `solobooks doctor` passes.

### 2. You

Their business's legal name, postal address, EIN, and the email address invoices come from.

```sh
solobooks profile set --legal-name "Jane Doe Consulting LLC" --address $'1 Main St\nSpringfield, IL 62701' \
  --ein 12-3456789 --email jane@example.com --source agent:<you>
```

solobooks needs the legal name, address and EIN before it can issue an invoice. Drafts work without them.

### 3. Getting paid

How clients pay them: bank details for ACH or wire, or a payment link. It is printed on every invoice.

```sh
solobooks profile payment instructions set --payment-instructions "ACH to First Bank, routing 011000015, account 1234567" --source agent:<you>
```

Payment instructions have their own command (the `profile_payment_instructions_set` tool); `profile set` refuses them. Changing them waits for the person's approval, because a swapped bank account is how invoice fraud works. You'll get a pending result: tell them it is waiting, and that they approve it on the solobooks page (see approvals.md). Carry on with the next questions while it waits.

### 4. Numbering

If they've invoiced before, what number should the next invoice get, so their sequence continues? If they're new, any number is fine (1001 looks less brand-new than 1).

```sh
solobooks profile set --next-invoice-number 1043 --source agent:<you>
```

This is fixed once the first invoice is issued. If they have past invoices to bring in, set it above the highest old number first.

### 5. First client

Name, billing email and address, the rate or fee and how often they bill it, payment terms, and a sales tax rate only if the person tells you they charge one.

"My first client is Acme at $150/hr, net 30":

```sh
solobooks client add --name "Acme Corp" --email ap@acme.example --address $'500 Market St\nSan Francisco, CA 94105' \
  --terms-days 30 --source agent:<you>
solobooks engagement add --client-id 1 --name "Consulting" --rate-cents-per-hour 15000 --source agent:<you>
```

Other shapes go on the same engagement or another one:

- A monthly retainer: `--recurring-amount-cents 500000 --recurring-interval monthly`.
- Fixed fees: `--json '{"client_id":1,"name":"Launch","milestones":[{"name":"Spec","amount_cents":250000,"billable_on":"2026-11-15"}]}'`.
- Time rounding, if they bill in increments: `client edit --id 1 --increment-minutes 6` (or `--minimum-minutes 15`).
- Sales tax only on their say-so, with the line kinds it covers: `client edit --id 1 --tax-rate-ppm 62500 --tax-label "IL sales tax" --tax-applies-to time,fixed`.

## The first draft

A draft bills whatever is unbilled, so record what they've done first. Ask what time they've worked for this client, and log it:

```sh
solobooks time add --client-id 1 --date 2026-10-03 --minutes 90 --note "Kickoff and API design" --source agent:<you>
solobooks invoice draft --client-id 1 --period-start 2026-10-01 --period-end 2026-10-31 --source agent:<you>
```

Show them the draft's lines and total in plain words. A draft has no number and can be edited (`invoice edit`) or deleted freely, and `invoice pdf` makes a PDF stamped DRAFT for them to look at.

When they want it to go out, run `invoice issue --id <draft id>`. It waits for their approval; see approvals.md. After it's approved, make the PDF and the email, send it through their mail, and record `invoice sent`.

## Backups

Ask where daily backups should go, ideally somewhere that leaves this machine, and run `solobooks backup set --folder <dir>`. If `solobooks doctor` or a write warned that the books sit in a synced folder, offer to move them now. See backups.md.

## Then ask about the past

Ask whether they have earlier invoices or expenses this year, and where they live (a spreadsheet, another books app, a folder of PDFs). If they do, follow prior-data.md.

## Finish

If you did onboarding through the CLI because the solobooks tools weren't loaded, tell the person to restart their agent app now (in Claude Code, quit and run `claude` again), so the tools load from the next conversation on. Nothing is lost: the books are on disk.
