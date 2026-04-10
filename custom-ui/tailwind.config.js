/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#f7f6f3',
        card: '#ffffff',
        accent: '#1a7a66',
        'accent-hover': '#14695a',
        'text-primary': '#1a1816',
        'text-secondary': '#636058',
        'border-color': '#e0ddd6',
      },
      fontFamily: {
        sans: ['Pretendard', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
