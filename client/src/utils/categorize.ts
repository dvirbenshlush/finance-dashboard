import type { TransactionCategory } from '../types';

interface Rule {
  patterns: RegExp[];
  category: TransactionCategory;
  /** Only apply to income (isDebit=false) */
  incomeOnly?: boolean;
  /** Only apply to expenses (isDebit=true) */
  debitOnly?: boolean;
}

const RULES: Rule[] = [
  // ======= INCOME =======
  {
    patterns: [/משכורת/i, /\bשכר\b/i, /salary/i, /\bמעסיק\b/i, /תלוש/i, /payroll/i, /\bHR\b/i],
    category: 'salary', incomeOnly: true,
  },
  {
    // Rental income received — landlord gets rent from tenant
    patterns: [/שכ\"ד/i, /שכר דירה/i, /\brent\b/i, /שוכר/i, /דמי שכירות/i, /שכירות.*זכות/i],
    category: 'rental_income', incomeOnly: true,
  },
  {
    patterns: [/החזר/i, /זיכוי/i, /refund/i, /credit note/i, /\bרפאנד\b/i,
               /הפקדת.?צ[\'׳]?ק/i, /הפקדת.?שק/i],
    category: 'refund', incomeOnly: true,
  },
  {
    // Incoming transfers / received payments — money arriving into the account
    patterns: [/העברת מ/i, /העברה מ/i, /קבלת תשלום/i, /תשלום התקבל/i, /זיכוי העברה/i],
    category: 'transfer_in', incomeOnly: true,
  },

  // ======= HOUSING =======
  {
    // Mortgage payment
    patterns: [/משכנתא/i, /mortgage/i, /\bבנק.*הלוואה\b/i],
    category: 'mortgage', debitOnly: true,
  },
  {
    // Rent paid to landlord
    patterns: [/שכר.?דירה/i, /\bשכירות\b/i, /\brent\b/i, /משכיר/i, /בעל הדירה/i, /דמי שכירות/i],
    category: 'rent_paid', debitOnly: true,
  },
  {
    // Building / municipal expenses
    patterns: [/ועד בית/i, /ארנונה/i, /עיריית/i, /municipality/i, /property tax/i],
    category: 'home_expenses',
  },

  // ======= FOOD =======
  {
    patterns: [
      /שופרסל/i, /רמי לוי/i, /\bמגה\b/i, /יינות ביתן/i, /ויקטורי/i,
      /AM:PM/i, /סיטי.?מרקט/i, /טיב טעם/i, /חצי חינם/i, /fresh market/i,
      /עדן טבע/i, /supermarket/i, /\bsuperpharm\b/i, /super.?pharm/i, /סופר.?פארם/i,
      /שוק/i, /groceries/i, /grocery/i,
    ],
    category: 'groceries',
  },
  {
    patterns: [
      /מסעד/i, /פיצ/i, /בורגר/i, /שווארמ/i, /סושי/i, /\bקפה\b/i,
      /\bcafe\b/i, /\bcoffee\b/i, /restaurant/i, /מקדונלד/i, /domino/i,
      /ארומה/i, /\baroma\b/i, /cofix/i, /קופיקס/i, /שיפודים/i, /hummus/i,
      /חומוס/i, /falafel/i, /פלאפל/i, /\bkfc\b/i, /\bsubway\b/i,
      /wolt/i, /ten.?bis/i, /תן.?ביס/i, /delivery/i, /\bפסטה\b/i,
      /מטבח/i, /אוכל/i, /\bbar\b/i, /\bpub\b/i,
    ],
    category: 'food_restaurant',
  },

  // ======= CAR =======
  {
    patterns: [
      /\bפז\b/i, /סונול/i, /\bBI\b/i, /\bדלק\b/i, /ten.?point/i,
      /yellow.?gas/i, /pi.?energy/i, /אורן.?גז/i, /חניה/i, /parking/i,
      /רישוי/i, /טסט/i, /מוסך/i, /garage/i, /\bקנס\b/i, /דו\"ח/i,
      /ביטוח.?רכב/i, /כלל.?רכב/i, /הפניקס.?רכב/i, /מגדל.?רכב/i,
      /\bleasing\b/i, /ליסינג/i, /\bauto\b/i,
    ],
    category: 'car',
  },

  // ======= PUBLIC TRANSPORT =======
  {
    patterns: [
      /רכבת ישראל/i, /\bאגד\b/i, /\bדן\b/i, /מטרופולין/i,
      /רב.?קו/i, /אוטובוס/i, /metro/i, /light.?rail/i, /train/i,
    ],
    category: 'public_transport',
  },

  // ======= SUBSCRIPTIONS =======
  {
    patterns: [
      /netflix/i, /spotify/i, /apple.com/i, /google.?play/i, /amazon.?prime/i,
      /disney/i, /paramount/i, /hulu/i, /wix/i, /canva/i, /adobe/i,
      /microsoft.?365/i, /\bHOT\b.*חבילה/i, /yes.*חבילה/i, /חבילת.*סלולר/i,
    ],
    category: 'subscriptions',
  },

  // ======= UTILITIES =======
  {
    patterns: [
      /בזק/i, /פרטנר/i, /\bסלקום\b/i, /hot.?net/i, /\b012\b/i, /גולן.?טלקום/i,
      /חברת.?חשמל/i, /\bחשמל\b/i, /\bמים\b/i, /גז.?ישראל/i,
      /cellcom/i, /\bHOT\b/i, /yes\s+tv/i, /סלולר/i, /\bmobile\b/i,
    ],
    category: 'utilities',
  },

  // ======= HEALTH =======
  {
    patterns: [
      /קופת.?חולים/i, /מכבי/i, /clalit/i, /כללית/i, /לאומית/i,
      /בית.?חולים/i, /רופא/i, /תרופ/i, /בית.?מרקחת/i, /pharmacy/i,
      /אופטיקה/i, /דנטל/i, /שיניים/i, /פיזיו/i, /ביטוח.?בריאות/i,
      /\bhealth\b/i, /\bclinic\b/i,
    ],
    category: 'health',
  },

  // ======= SHOPPING =======
  {
    patterns: [
      /\bzara\b/i, /h&m/i, /\bshein\b/i, /\bfox\b/i, /\bcastro\b/i,
      /adidas/i, /\bnike\b/i, /\bamazon\b/i, /\bikea\b/i, /\bace\b/i,
      /home.?center/i, /\bKSP\b/i, /\bivory\b/i, /idigital/i,
      /\bgolf\b/i, /ביגוד/i, /אופנה/i, /fashion/i, /\bbug\b/i,
    ],
    category: 'shopping',
  },

  // ======= INVESTMENT =======
  {
    patterns: [
      /פיקדון/i, /ני\"ע/i, /קרן.?נאמנות/i, /etf/i, /crypto/i,
      /ביטקוין/i, /בורסה/i, /interactive.?brokers/i, /מסחר.?בני\"ע/i,
    ],
    category: 'investment',
  },

  // ======= TRAVEL =======
  {
    patterns: [
      /אל.?על/i, /\bel.?al\b/i, /ryanair/i, /easyjet/i, /wizz/i,
      /booking\.com/i, /airbnb/i, /\bמלון\b/i, /\bhotel\b/i,
      /נמל.?תעופה/i, /airport/i, /expedia/i, /\bטיסה\b/i,
    ],
    category: 'travel',
  },

  // ======= ENTERTAINMENT =======
  {
    patterns: [
      /yes.?planet/i, /סינמה/i, /קולנוע/i, /תיאטרון/i, /theater/i,
      /מוזיאון/i, /bowling/i, /escape.?room/i, /ספורט/i,
      /gym/i, /fitness/i, /איזי.?ג'ים/i,
    ],
    category: 'entertainment',
  },

  // ======= EDUCATION =======
  {
    patterns: [
      /שכר.?לימוד/i, /אוניברסיטה/i, /מכללה/i, /\bקורס\b/i,
      /גן.?ילדים/i, /צהרון/i, /udemy/i, /coursera/i,
    ],
    category: 'education',
  },
];

/**
 * Instant keyword-based categorization, no API needed.
 * Returns `undefined` if no rule matched — AI will handle those.
 */
export const categorizeByKeyword = (
  description: string,
  isDebit: boolean
): TransactionCategory | undefined => {
  for (const rule of RULES) {
    if (rule.incomeOnly && isDebit) continue;
    if (rule.debitOnly && !isDebit) continue;
    if (rule.patterns.some((p) => p.test(description))) return rule.category;
  }

  // No keyword matched → let AI decide for both income and expense
  return undefined;
};
