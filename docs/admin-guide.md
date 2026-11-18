# Admin guide

For the organisers who run registrations. The admin panel is at `/admin` on the site.

## Signing in

There are two kinds of account.

| Account | Created by | Can do |
| --- | --- | --- |
| **Owner** | The server settings (`ADMIN_USERNAME`, `ADMIN_PASSWORD` in `.env`) | Everything, including adding and removing organisers |
| **Organiser** | The owner, under Settings, Organiser accounts | Everything except managing accounts |

- A session lasts 8 hours. After that you sign in again.
- 8 wrong passwords from one network lock sign in from that network for 15 minutes.
- Give every person their own organiser account. Do not share the owner password.

## First time setup, in order

1. **Settings**: enter the **UPI ID** and payee name. Registrations stay closed until a UPI ID is set.
2. **Student list**: upload the 1st year list (see below).
3. **Student list**: press **Check connection**, then **Send test** to your own email.
4. **Student list**: tick **Only students on this list can register** and
   **The team leader must verify their email with a code**.
5. **Events**: check each event's team size, limit and fee.
6. **Settings**: add an organiser account for each person helping you.
7. **Overview**: confirm there are no warnings.
8. Register one test team from a phone, approve it, then delete it.

## Overview

- **Waiting for verification**: registrations nobody has checked yet. This is your to-do count.
- **Approved**, **Verified collection**, **Rejected**: totals.
- **Event fill**: how many slots each event has used. Pending and approved both hold a slot.
- **Student list**: how many students are loaded and whether the checks are on.
- **Registration window**: open or close everything at once.

Warnings that can appear at the top:

| Warning | What to do |
| --- | --- |
| No UPI ID is set | Add it under Settings. |
| The virus scanner is not responding | Wait a minute after a restart. If it stays, see [Operations](operations.md#troubleshooting). |
| Registrations were uploaded while the scanner was unavailable | Information only. Those screenshots were still cleaned by re-encoding. |

## Registrations

- **Search** matches registration ID, team name, any member's name or roll number, phone, email and
  transaction ID. Filter by event and status.
- Click a row to open it: members, amount, transaction ID, and the payment screenshot (click the
  image for full size).
- **Approve payment** confirms the team. **Reject** needs a reason; the team sees it in their status
  and by email. **Move back to pending** undoes an approval.
- A rejected registration cannot be reopened. Rejecting frees the team's slot, roll numbers and
  transaction ID, so they can register again.
- **Delete** removes the registration and its screenshot for good.

### Exports

Exports follow the current search and filters.

| Format | Use it for |
| --- | --- |
| Excel (.xlsx) | Attendance sheets and sharing with the department |
| CSV | Importing into other tools |
| JSON | Developers |

Choose **One row per team** (for payment tracking) or **One row per participant** (for attendance).

Exported files are **not encrypted** and contain student details. Keep them on a trusted device and
delete them when you are done.

## Bank statement

This checks many payments at once.

1. Download the statement for the UPI account from net banking as **Excel (.xlsx)** or **CSV**.
   For a PDF statement, open it, select all, copy, and paste the text into the box.
2. Upload it (or paste) and press **Match payments**.
3. Every pending registration gets a result:

| Result | Meaning | What to do |
| --- | --- | --- |
| **Match** | The transaction ID is in the statement and the right amount is in the same row | Safe to approve. Ticked for you. |
| **Check amount** | The transaction ID is there, but the expected amount was not seen in that row | Read the statement row shown. Approve only if the amount is right. |
| **Not found** | The transaction ID is not in this statement | The payment may be later than the statement, typed wrong, or fake. |

4. **Approve ticked matches** approves them all.
5. **Reject ticked "not found"** rejects the ones you tick. Before using it, make sure the statement
   covers the dates those teams paid. Rejection cannot be undone.

The statement is virus scanned, read in memory, and never saved on the server.

## Events

Add, edit and remove events.

| Field | Meaning |
| --- | --- |
| Team event | Untick for a solo event |
| Minimum and maximum team size | Counts the leader |
| Maximum number of teams (or participants for solo) | 0 means no limit. Entries stop when it is reached. |
| Fee per participant | In rupees. The amount to pay is fee times team size. |
| Position in the list | Lower numbers show first |
| Accepting entries | Close one event without closing the others |

Removing an event that already has registrations hides it from the site and keeps the registrations.

## Student list

The list of students who are allowed to register.

### File format

One student per row, the first row being the column headings. Excel (.xlsx) or CSV, up to 5 MB and
20,000 rows. Old `.xls` files must be saved as `.xlsx` first. A template is on the page.

| Column | Needed | Headings that are recognised | Content |
| --- | --- | --- | --- |
| Roll number | Yes | Roll number, Roll No, USN, Reg No, Registration number, Admission No, Student ID | 3 to 20 letters and digits, also `/` and `-`. Capitals and spaces do not matter. |
| Name | Yes | Name, Student Name, Full Name | Full name |
| Branch | No | Branch, Department, Dept, Section, Course, Program, Stream | Any text |
| Phone | No | Phone, Mobile, Mobile No, Contact, WhatsApp | 10 digit Indian mobile number |
| Email | No, but needed for email verification | Email, E-mail, Email ID | The address the code is sent to |

- Columns can be in any order. Extra columns are ignored. A title row above the headings is fine.
- A row is skipped if the roll number is invalid, the name is empty, or the roll number already
  appeared. The result lists the skipped rows and why.
- **Replace the whole list** swaps the list. **Add to the list and update existing** keeps what is
  there and updates matching roll numbers. Neither changes existing registrations.

### The three switches

| Switch | Effect |
| --- | --- |
| Only students on this list can register | Roll numbers not on the list are refused. Names and branch come from the list and cannot be edited by students. |
| The team leader's phone must match the phone on this list | For lists with phone numbers. A leader whose number changed will need you to update the list. |
| The team leader must verify their email with a code | A code is emailed before payment. Needs email to be set up. |

### Email

- **Check connection** signs in to the mail server and sends nothing.
- **Send test** sends one email to the address you type.
- The status line shows the sender, the mail server, and how many emails were sent today against the
  daily limit.

If a student says no code arrived: ask them to check Spam, wait 60 seconds and press Resend. If the
email on the list is wrong, fix the list (Add to the list and update existing, with just that row).

## Settings

- **Registration window**: Open, Closed, or Scheduled with an opening and closing time.
- **Payment**: UPI ID and the payee name students see.
- **Event details**: name, date, contact person and phone (shown publicly), and an optional notice on the home page.
- **Rules**: whether a student may join more than one event (off by default), and the branch list
  used when the student list is off.
- **Organiser accounts**: add and remove organisers (owner only). Organisers can change their own password here.

## Activity log

Every sign in, failed sign in, approval, rejection, deletion, export, import and settings change, with
the account that did it and the time. Use it when you need to know who approved something.

## Handling common situations

| Situation | What to do |
| --- | --- |
| A student says someone else registered with their roll number | Search the roll number under Registrations. Reject or delete that registration. The student can then register. |
| A team typed the wrong transaction ID | Reject with that reason. They register again with the right ID. |
| A team wants to change a member | Reject (or delete) their registration and ask them to register again. Details cannot be edited. |
| A team paid the wrong amount | Reject with the reason, and settle the refund outside the site. |
| An event needs more slots | Events, Edit, raise the maximum. |
| You need to stop registrations right now | Overview, Close now. |
| An organiser leaves | Settings, Organiser accounts, Remove. They are signed out at once. |
