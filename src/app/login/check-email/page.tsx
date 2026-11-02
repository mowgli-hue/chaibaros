export default function CheckEmail() {
  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="card w-full max-w-sm text-center">
        <h1 className="text-xl font-semibold mb-2">Check your email</h1>
        <p className="text-sm text-[#7a6a5c]">
          We sent you a sign-in link. It works once and expires in 24 hours. In local development the link is printed in the server console.
        </p>
      </div>
    </main>
  );
}
