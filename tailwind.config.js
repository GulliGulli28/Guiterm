/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Une seule échelle de rayons pour toute l'app : 6 px pour ce qu'on
      // manipule (boutons, champs, lignes), 8 px pour les cartes et menus,
      // 12 px pour ce qui flotte au-dessus de tout (modales, palette).
      borderRadius: {
        sm: "4px",
        DEFAULT: "5px",
        md: "6px",
        lg: "8px",
        xl: "12px",
        "2xl": "16px",
      },
      fontFamily: {
        sans: ["var(--font-ui)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
};
