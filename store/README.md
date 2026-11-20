# Publishing to the Microsoft Store

Store apps are signed by Microsoft, so users installing from the Store never see the "Windows protected your PC" warning. You stay the publisher and owner; Microsoft only hosts and delivers the app.

## 1. Create a developer account (free for individuals)

1. Go to <https://storedeveloper.microsoft.com> and choose **Individual developer**.
2. Sign in with your Microsoft account and complete identity verification (ID document and selfie).

## 2. Reserve the app name

1. In **Partner Center → Apps and games**, choose **New product → MSIX or PWA app**.
2. Reserve a name. It must be unique in the Store, and plain "Screen Snap" is almost certainly taken, so pick something distinctive.

## 3. Give the build your app identity

1. In Partner Center open **Product management → Product identity** and copy:
   - `Package/Identity/Name`
   - `Package/Identity/Publisher` (looks like `CN=XXXXXXXX-XXXX-…`)
   - `Package/Properties/PublisherDisplayName`
2. In GitHub open **Settings → Secrets and variables → Actions → Variables**, and add these **repository variables** (variables, not secrets):

   | Variable | Value |
   | --- | --- |
   | `STORE_IDENTITY_NAME` | Package/Identity/Name |
   | `STORE_PUBLISHER` | Package/Identity/Publisher |
   | `STORE_PUBLISHER_DISPLAY_NAME` | Package/Properties/PublisherDisplayName |
   | `STORE_DISPLAY_NAME` | The name you reserved |

3. Re-run the latest **Build apps** workflow (Actions → Build apps → Run workflow). It produces a **screen-snap-microsoft-store** artifact containing the `.appx` package.

## 4. Create the submission

| Section | What to enter |
| --- | --- |
| Pricing and availability | **Free** (or set a price) |
| Properties | Category: **Photo & video** (or Productivity) |
| Age ratings | Complete the questionnaire (no objectionable content) |
| Packages | Upload the `.appx` from the artifact |
| Store listing | Paste from [listing.md](listing.md); add 1–4 screenshots of the app (at least 1366×768) |
| Privacy policy URL | Required, because the app can use the microphone. Publish [privacy-policy.md](privacy-policy.md) somewhere public (e.g. a public GitHub Gist) and paste the link |
| Submission options → restricted capabilities | Explain **runFullTrust** with the text in [listing.md](listing.md) |

Submit. Certification usually takes a few business days, and Microsoft emails you the result.

## Updating the app

Bump `version` in `package.json`, push, download the new Store artifact, and create a new submission with it. The Store delivers the update to users automatically.
