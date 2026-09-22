require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const pool = require("./db");
const { authenticateToken, authorizeRole } = require("./middlewares/auth");
const { parsePagination, parseSort } = require("./middlewares/query-parser");
const { hashPassword, verifyPassword, generateToken } = require("./auth-helpers");

const schema = require("./schema");
const root = require("./resolvers");

const app = express();
const v1Router = express.Router();
const v2Router = express.Router();

// 1. Security & Logging Middlewares
app.use(helmet());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  }),
);
app.use(morgan("dev"));
app.use(express.json({ limit: "10kb" }));

// 2. Base Routes
app.use("/api/v1", v1Router);
app.use("/api/v2", v2Router);

// ---------------- API v1 Routes ----------------

v1Router.get("/", (req, res) => {
  res.status(200).json({ message: "Student API พร้อมใช้งานแล้วจ้า" });
});

// 1. GET: ดึงรายการนักศึกษาทั้งหมด
v1Router.get(
  "/students",
  parsePagination,
  parseSort,
  async (req, res, next) => {
    const { major } = req.query;
    const { page, limit, offset } = req.pagination;
    const { field, order } = req.sort;

    let baseQuery = "SELECT * FROM students";
    let countQuery = "SELECT COUNT(*) AS total FROM students";
    const params = [];

    if (major) {
      baseQuery += " WHERE major = ?";
      countQuery += " WHERE major = ?";
      params.push(major);
    }

    baseQuery += ` ORDER BY ${field} ${order} LIMIT ? OFFSET ?`;

    try {
      const [rows] = await pool.query(baseQuery, [...params, limit, offset]);
      const [[{ total }]] = await pool.query(countQuery, params);

      res.status(200).json({
        message: "สำเร็จ",
        data: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// 2. GET: ดึงข้อมูลนักศึกษารายบุคคลตาม id
v1Router.get("/students/:id", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM students WHERE id = ?", [
      req.params.id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "ไม่พบข้อมูลนิสิต" },
      });
    }

    res.status(200).json({ message: "สำเร็จ", data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// // 3. POST: เพิ่มข้อมูลนักศึกษาใหม่
// v1Router.post("/students", async (req, res, next) => {
//   const { name, major, email } = req.body;
//   try {
//     const [result] = await pool.query(
//       "INSERT INTO students (name, major, email) VALUES (?, ?, ?)",
//       [name, major, email],
//     );

//     // ใช้ redisClient กรณีที่จำเป็น แต่ตัว connectRedis จะย้ายไปอยู่ที่ server.js
//     const { redisClient } = require("./cache");
//     if (redisClient && redisClient.isOpen) {
//       await redisClient.del("students:all");
//     }

//     res.status(201).json({
//       message: "เพิ่มข้อมูลสำเร็จ",
//       data: { id: result.insertId, name, major, email },
//     });
//   } catch (err) {
//     if (err.code === "ER_DUP_ENTRY") {
//       return res.status(409).json({
//         error: { code: "DUPLICATE_EMAIL", message: "อีเมลนี้มีอยู่ในระบบแล้ว" },
//       });
//     }
//     next(err);
//   }
// });

// POST: ลงทะเบียนเรียน (แก้ไขแก้เติม slash เป็น /students/:id/enrollments)
v1Router.post("/students/:id/enrollments", async (req, res, next) => {
  const studentId = req.params.id;
  const { courseId } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [courseRows] = await connection.query(
      "SELECT * FROM courses WHERE id = ? FOR UPDATE",
      [courseId],
    );

    if (courseRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        error: { code: "COURSE_NOT_FOUND", message: "ไม่พบรายวิชาที่ระบุ" },
      });
    }

    if (courseRows[0].seat_available <= 0) {
      await connection.rollback();
      return res.status(409).json({
        error: { code: "SEAT_FULL", message: "ที่นั่งเต็มแล้ว" },
      });
    }

    await connection.query(
      "INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)",
      [studentId, courseId],
    );

    await connection.query(
      "UPDATE courses SET seat_available = seat_available - 1 WHERE id = ?",
      [courseId],
    );

    await connection.commit();
    res.status(201).json({ message: "ลงทะเบียนสำเร็จ" });
  } catch (err) {
    await connection.rollback();
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: {
          code: "ALREADY_ENROLLED",
          message: "นิสิตลงทะเบียนรายวิชานี้ไปแล้ว",
        },
      });
    }
    next(err);
  } finally {
    connection.release();
  }
});

// // 4. PUT: แก้ไขข้อมูลนักศึกษา
// v1Router.put("/students/:id", (req, res) => {
//   const id = Number(req.params.id);
//   const { name, major } = req.body;
  
//   if (!name || !major) {
//     return res
//       .status(400)
//       .json({ message: "กรุณาระบุ name และ major ให้ครบถ้วน" });
//   }

//   res.status(200).json({ message: "แก้ไขข้อมูลสำเร็จ" });
// });

// 5. DELETE: ลบข้อมูลนักศึกษา
v1Router.delete(
  "/students/:id",
  authenticateToken,
  authorizeRole("admin"),
  async (req, res, next) => {
    try {
      const [result] = await pool.query("DELETE FROM students WHERE id = ?", [
        req.params.id,
      ]);
      if (result.affectedRows === 0) {
        return res.status(404).json({
          error: { code: "NOT_FOUND", message: "ไม่พบข้อมูลนิสิต" },
        });
      }
      res.status(200).json({ message: "ลบข้อมูลสำเร็จ" });
    } catch (err) {
      next(err);
    }
  },
);

// 6. GET: ดูข้อมูลนิสิตพร้อมรายวิชา
v1Router.get("/students/:id/full", (req, res) => {
  res.status(200).json({ message: "สำเร็จ" });
});

// 7. GET: ดูข้อมูลส่วนตัวผู้ล็อกอิน
v1Router.get("/auth/me", authenticateToken, (req, res) => {
  res.status(200).json({ message: "สำเร็จ", data: req.user });
});

// Auth Routes (แก้ไขแก้เติม slash เป็น /auth/register)
v1Router.post("/auth/register", async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "กรุณาระบุ email และ password",
      },
    });
  }

  try {
    const passwordHash = await hashPassword(password);
    const [result] = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'student')",
      [email, passwordHash],
    );

    res.status(201).json({
      message: "สมัครสมาชิกสำเร็จ",
      data: { id: result.insertId, email, role: "student" },
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        error: { code: "DUPLICATE_EMAIL", message: "อีเมลนี้มีอยู่ในระบบแล้ว" },
      });
    }
    next(err);
  }
});

v1Router.post("/auth/login", async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "กรุณาระบุ email และ password",
      },
    });
  }

  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (rows.length === 0) {
      return res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
        },
      });
    }

    const user = rows[0];
    const isPasswordValid = await verifyPassword(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
        },
      });
    }

    const token = generateToken(user);
    res.status(200).json({ message: "เข้าสู่ระบบสำเร็จ", token });
  } catch (err) {
    next(err);
  }
});

// PATCH: แก้ไขข้อมูลบางส่วน
v1Router.patch("/students/:id", (req, res) => {
  res.status(200).json({ message: "แก้ไขข้อมูลสำเร็จ" });
});

// ---------------- API v2 Routes ----------------

v2Router.get("/students", async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM students");
    res.status(200).json({ items: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// 404 Handler
v1Router.use((req, res) => {
  res.status(404).json({
    error: { code: "ROUTE_NOT_FOUND", message: "ไม่พบเส้นทางที่ร้องขอ" },
  });
});

// Global Error Handler
v1Router.use((err, req, res, next) => {
  console.error(err.stack);
  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: {
      code: statusCode === 500 ? "INTERNAL_SERVER_ERROR" : err.type || "ERROR",
      message: statusCode === 500 ? "เกิดข้อผิดพลาดที่ไม่คาดคิดภายในระบบ" : err.message,
    },
  });
});

// ส่งออก app ตัวเดียว ห้ามมี app.listen หรือ connectRedis ในไฟล์นี้
module.exports = app;