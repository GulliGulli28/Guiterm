/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Échelle de rayons resserrée : un outil d'administration se lit comme
      // un panneau d'instruments, pas comme une galerie de cartes. `rounded-xl`
      // reste utilisable dans le code mais vaut 8 px, pas 12.
      borderRadius: {
        sm: "3px",
        DEFAULT: "4px",
        md: "5px",
        lg: "6px",
        xl: "8px",
        "2xl": "10px",
      },
      fontFamily: {
        sans: ["var(--font-ui)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
};
