import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Paleta de marca: navy profundo (premium financiero) + neutros fríos.
        brand: {
          50: "#eef2f8",
          100: "#d8e2ee",
          200: "#b3c6dd",
          300: "#88a4c6",
          400: "#5d80a9",
          500: "#3d618a",
          600: "#2b4a6e",
          700: "#1f3a59", // primario (botones, estados activos)
          800: "#16293f",
          900: "#0d1a29",
        },
        // Dorado sutil de acento, usado con moderación.
        gold: {
          400: "#cbab73",
          500: "#b9954f",
          600: "#9b7a39",
        },
        surface: "#f4f6f9", // fondo de app / sidebar
        ink: "#16202e", // texto principal
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
