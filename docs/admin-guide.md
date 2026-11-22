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

1. **Settings**: choose **how the fee is collected** (UPI or cash, one for everyone). For UPI enter the **UPI ID** and payee
   name; for cash write **where and to whom to pay**. Registrations stay closed until there is a way to pay:
   a UPI ID, or the cash option.
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

- **Search** matches registration ID, team name, any member's name or ERP ID, phone, email and
  transaction ID. Filter by event, **half**, **department** (the student's branch), **section**, status and
  **payment** (UPI or cash). The department and section filters show every team that has at least one
  member from that department or section.
- Click a row to open it: members, amount, transaction ID, and the payment screenshot (click the
  image for full size).
- A registration that pays in **cash** shows a Cash badge instead of a transaction ID and has no screenshot.
  Open it once the team has paid and press **Mark cash received**. Until then it stays pending. To clear
  out teams that never paid, filter Payment = Cash and Status = Pending, then reject them with a reason;
  that frees their slots and ERP IDs.
- **Approve payment** confirms the team. **Reject** needs a reason; the team sees it in their status
  and by email. **Move back to pending** undoes an approval.
- A rejected registration cannot be reopened. Rejecting frees the team's slot, ERP IDs and
  transaction ID, so they can register again.
- **Delete** removes the registration and its screenshot for good.

### Editing a team

Open a pending or approved registration and press **Edit team**.

| You want to | Do this |
| --- | --- |
| Remove a member | **Remove** on that member's card |
| Add a member | **Add a member**, then type the ERP ID. Name, branch, section and phone fill in from the student list. |
| Fix a section | Type it in the Section box of that member. |
| Change the leader | **Make leader** on the member who should lead. They move to the top. The leader needs a phone number. |
| Fix a phone number, the team name, the leader's email or the transaction ID | Change the field |
| Fix the spelling of a name | Names that come from the student list are locked here. Correct the student under **Student list**, and every team they are in is updated. |
| Leave a note for other organisers | The Note field, for example how the team paid |

Nothing is saved until you press **Save changes**, and the team is not emailed about edits.

What the editor checks:

- A student who is already in another team cannot be added. The message names the team, so you can
  remove them there first.
- With the student list on, an ERP ID that is not on the list is refused. Add the student first.
- A team size outside the event's range, or an event that is already full, shows a **Save anyway?**
  question instead of blocking you. You decide.
- The amount follows the team size. If it changes, you are told the old and new amount so you can
  settle the difference with the team. The status (pending or approved) is not changed.

A **rejected** registration cannot be edited; add the team by hand instead.

### Adding a registration by hand

**Add a registration by hand**, at the top of the Registrations tab, is for a team that paid in cash,
a late entry you have agreed to, or redoing a rejected registration.

1. Choose the event and type the team name.
2. Type the leader's ERP ID and phone, then add the other members.
3. Enter the UPI transaction ID if there is one, or leave it empty and write how they paid in the Note.
4. Choose **Approved** if you have the money, or **Pending** to verify later.

This skips the captcha, the email code and the screenshot, because you are vouching for the team. The
rule about one event in each half still applies. The registration is marked "added by an organiser" in the
list and in exports, the activity log records who added it, and an approved team gets the usual
confirmation email.

### Exports

Exports follow the current search and filters: event, half, department, section, status and payment.
The blue bar above the list says in words what the export will contain, for example
"Poster Presentation, department ECE, section A". Set the filters, read that line, then press Excel or CSV.

| Format | Use it for |
| --- | --- |
| Excel (.xlsx) | Attendance sheets and sharing with the department |
| CSV | Importing into other tools |
| JSON | Developers |

Choose **One row per team** (for payment tracking) or **One row per participant** (for attendance).
Both have **Half** and the per participant export has **Branch** and **Section** columns.

Useful combinations:

| You want | Set |
| --- | --- |
| Everyone in one event | Event, then One row per participant |
| Attendance sheet for the 1st half | Half = 1st half, One row per participant |
| All ECE students taking part | Branch = ECE, One row per participant. Only the ECE students are listed, even from mixed teams. |
| One class section | Section, One row per participant. Only that section's students are listed. |
| One department's students in one event | Event and Department, One row per participant |
| Who still has to pay in cash | Payment = Cash, Status = Pending, One row per team |
| Cash collected so far | Payment = Cash, Status = Approved, One row per team. The Amount column adds up to the cash in hand. |
| Teams still to be verified in one event | Event, Status = Pending, One row per team |

With One row per team, a branch or section filter keeps the whole team if any member matches.

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
| Rules and format | One rule per line. Students see them on the event card and again when they pick the event, and must tick that they have read them before they can continue. The five built in events start with rules taken from the department's event flow document; edit them freely. |
| Half of the day | 1st half or 2nd half. A student can join one event in each half. An event with no half set counts as the whole day, so it clashes with every other event. **Set this for every event before opening registration.** |
| Code for registration IDs | Two to four letters, for example PP for Poster Presentation or TB for Treasure Hunt + Bounty. Registration IDs are the code and a running number: `IDT26-TB001`, `IDT26-TB002`. Leave it empty and one is made from the title. Each event needs its own code. |

Removing an event that already has registrations hides it from the site and keeps the registrations.

## Student list

The list of students who are allowed to register.

### File format

One student per row, the first row being the column headings. Excel (.xlsx) or CSV, up to 5 MB and
20,000 rows. Old `.xls` files must be saved as `.xlsx` first. A template is on the page.

| Column | Needed | Headings that are recognised | Content |
| --- | --- | --- | --- |
| ERP ID | Yes | ERP ID, Roll No, USN, Reg No, Registration number, Admission No, Student ID | 3 to 20 letters and digits, also `/` and `-`. Capitals and spaces do not matter. |
| Name | Yes | Name, Student Name, Full Name | Full name |
| Branch | No | Branch, Department, Dept, Course, Program, Stream | Any text |
| Section | No | Section, Sec, Division | The class section. "A", "Sec A" and "section a" are all read as A. When it is missing, the student picks it in the form. |
| Phone | No | Phone, Mobile, Mobile No, Contact, WhatsApp | 10 digit Indian mobile number |
| Email | No, but needed for email verification | Email, E-mail, Email ID | The address the code is sent to |

- Columns can be in any order. Extra columns are ignored. A title row above the headings is fine.
- A row is skipped if the ERP ID is invalid, the name is empty, or the ERP ID already
  appeared. The result lists the skipped rows and why.
- **Replace the whole list** swaps the list. **Add to the list and update existing** keeps what is
  there and updates matching ERP IDs. Neither changes existing registrations.

### Correcting one student

After a bulk upload you do not need to upload the file again to fix one row.

- **Edit** on a student's row changes the name, branch, section, phone or email. A corrected name,
  branch or section is also updated in every registration that student is in, so attendance sheets come out right. A new
  email also becomes the contact email of a team that student leads.
- **Add one student** adds a single student who was missing from the file.
- **Remove** takes a student off the list. It does not touch a registration they are already in.
- The ERP ID itself cannot be changed. Remove the student and add them again with the right one.

### The three switches

| Switch | Effect |
| --- | --- |
| Only students on this list can register | ERP IDs not on the list are refused. Names and branch come from the list and cannot be edited by students. |
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
- **Payment**: how the fee is collected. **Online by UPI** asks for a transaction ID and a screenshot.
  **In cash** asks for nothing online: the student registers, pays an organiser, and the organiser presses
  Mark cash received. It is one or the other for everyone; students do not choose. Also here: the UPI ID and payee name, and the
  line that tells cash payers where and to whom to pay. The Overview shows cash still to collect and
  cash collected so far.
- **Event details**: name, date, contact person and phone (shown publicly), and an optional notice on the home page.
- **Rules**: the **instructions** shown in the "Read this first" box before a student picks an event
  (one per line), how many events a student may join (**one event in each half** to start with; the other
  choices are one event only, or any number), the branch list used
  when the student list is off, and the **section list** students pick from (A to P to start with;
  change it to match your college). A section that comes from the student list is used as it is.
  **Let students choose "Other"** adds an "Other (type it)" choice for a section that is not in the
  list; it is on to start with. Typed sections are stored in capitals ("sec q2" becomes Q2) and show
  up in the section filter and in exports. Untick it to accept only the sections in your list.
- **Organiser accounts**: add and remove organisers (owner only). Organisers can change their own password here.

## Activity log

Every sign in, failed sign in, approval, rejection, deletion, export, import and settings change, with
the account that did it and the time. Use it when you need to know who approved something.

## Handling common situations

| Situation | What to do |
| --- | --- |
| A student says someone else registered with their ERP ID | Search the ERP ID under Registrations. Reject or delete that registration. The student can then register. |
| A team typed the wrong transaction ID | Reject with that reason. They register again with the right ID. |
| A team wants to change a member | Open the registration, **Edit team**, remove the old member and add the new one. |
| A team paid in cash | **Add a registration by hand**, leave the transaction ID empty, and write a Note. |
| A name is misspelt on the list | Student list, **Edit** on that student. Their teams are updated too. |
| A team paid the wrong amount | Reject with the reason, and settle the refund outside the site. |
| An event needs more slots | Events, Edit, raise the maximum. |
| You need to stop registrations right now | Overview, Close now. |
| An organiser leaves | Settings, Organiser accounts, Remove. They are signed out at once. |
