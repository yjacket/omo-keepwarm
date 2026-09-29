// QA only. Minimal Windows ConPTY host: runs a command line inside a pseudo console so the child sees a real TTY.
//   conpty-host.exe <cols> <rows> "<full command line>"
// stdin bytes are written to the pseudo console input, pseudo console output goes to stdout verbatim.
// Exit code = child's exit code. Built on demand by qa/pty-driver.mjs with the .NET Framework csc.exe.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class ConPtyHost
{
    [StructLayout(LayoutKind.Sequential)]
    struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr hRead, out IntPtr hWrite, IntPtr attrs, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr phPC);
    [DllImport("kernel32.dll")]
    static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr cb, IntPtr prev, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

    static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("usage: conpty-host <cols> <rows> <command line>");
            return 64;
        }
        short cols = short.Parse(args[0]);
        short rows = short.Parse(args[1]);
        string commandLine = args[2];

        IntPtr inRead, inWrite, outRead, outWrite;
        if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) return Fail("CreatePipe(in)");
        if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) return Fail("CreatePipe(out)");

        COORD size = new COORD();
        size.X = cols;
        size.Y = rows;
        IntPtr hPC;
        int hr = CreatePseudoConsole(size, inRead, outWrite, 0, out hPC);
        if (hr != 0)
        {
            Console.Error.WriteLine("CreatePseudoConsole failed hr=0x" + hr.ToString("x"));
            return 70;
        }

        IntPtr listSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
        IntPtr list = Marshal.AllocHGlobal(listSize);
        if (!InitializeProcThreadAttributeList(list, 1, 0, ref listSize)) return Fail("InitializeProcThreadAttributeList");
        if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            return Fail("UpdateProcThreadAttribute");

        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.lpAttributeList = list;
        // Null std handles: without this the child inherits this host's redirected std handles instead of the pseudo console.
        si.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
        PROCESS_INFORMATION pi;
        StringBuilder cmd = new StringBuilder(commandLine);
        if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref si, out pi))
            return Fail("CreateProcessW");

        // The pseudo console owns these ends now.
        CloseHandle(inRead);
        CloseHandle(outWrite);

        Stream stdout = Console.OpenStandardOutput();
        Stream stdin = Console.OpenStandardInput();
        FileStream ptyOut = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read, 4096, false);
        FileStream ptyIn = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write, 1, false);

        Thread pump = new Thread(delegate ()
        {
            byte[] buf = new byte[8192];
            try
            {
                int n;
                while ((n = ptyOut.Read(buf, 0, buf.Length)) > 0)
                {
                    stdout.Write(buf, 0, n);
                    stdout.Flush();
                }
            }
            catch (IOException) { }
        });
        pump.Start();

        Thread feed = new Thread(delegate ()
        {
            byte[] buf = new byte[4096];
            try
            {
                int n;
                while ((n = stdin.Read(buf, 0, buf.Length)) > 0)
                {
                    ptyIn.Write(buf, 0, n);
                    ptyIn.Flush();
                }
            }
            catch (IOException) { }
        });
        feed.IsBackground = true;
        feed.Start();

        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        // Closing the pseudo console flushes the remaining output and ends the reader.
        ClosePseudoConsole(hPC);
        pump.Join(5000);
        return unchecked((int)code);
    }

    static int Fail(string what)
    {
        Console.Error.WriteLine(what + " failed, error " + Marshal.GetLastWin32Error());
        return 70;
    }
}
