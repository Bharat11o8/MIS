"""
AutoForm MIS — Updated SQLAlchemy ORM Models (Phase 3)
"""
import uuid
from sqlalchemy import Column, String, Boolean, Integer, Date, Text, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
from sqlalchemy import TIMESTAMP
from database import Base


class User(Base):
    __tablename__ = "users"

    id                   = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name                 = Column(String(100), nullable=False)
    email                = Column(String(150), unique=True, nullable=False)
    password_hash        = Column(Text, nullable=False)
    role                 = Column(String(50), nullable=False)
    department           = Column(String(100))
    is_active            = Column(Boolean, default=True)
    must_change_password  = Column(Boolean, default=False)
    reset_otp             = Column(String(6), nullable=True)
    reset_otp_expires_at  = Column(TIMESTAMP(timezone=True), nullable=True)
    created_by            = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at            = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at            = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class Lead(Base):
    __tablename__ = "leads"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lead_date       = Column(Date, nullable=False)
    source          = Column(String(30), nullable=False)
    customer_name   = Column(String(200))
    mobile_number   = Column(String(20))
    car_type        = Column(String(100))
    product_type    = Column(String(200))
    location        = Column(String(200))
    state           = Column(String(100))
    call_status     = Column(String(50))
    reason          = Column(Text)
    reason_category = Column(String(50))
    assigned_asm    = Column(String(100))
    review_status   = Column(String(50))
    review_reason   = Column(Text)
    upload_log_id   = Column(UUID(as_uuid=True), ForeignKey("upload_logs.id", ondelete="SET NULL"), nullable=True)
    uploaded_by     = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())


class UploadLog(Base):
    __tablename__ = "upload_logs"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    module        = Column(String(50), nullable=False)
    filename      = Column(String(255), nullable=False)
    rows_total    = Column(Integer, default=0)
    rows_success  = Column(Integer, default=0)
    rows_failed   = Column(Integer, default=0)
    status        = Column(String(30), default="Processing")
    error_details = Column(Text)
    uploaded_by   = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    uploaded_at   = Column(TIMESTAMP(timezone=True), server_default=func.now())


class SalesDispatch(Base):
    __tablename__ = "sales_dispatches"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    invoice_no    = Column(String(50), unique=True, nullable=False)
    dispatch_date = Column(Date, nullable=False)
    plant_name    = Column(String(100), nullable=False)
    depot_name    = Column(String(100), nullable=False)
    sku           = Column(String(100), nullable=False)
    product_name  = Column(String(200))
    quantity      = Column(Integer, nullable=False)
    vehicle_no    = Column(String(30))
    driver_name   = Column(String(100))
    status        = Column(String(30), default="Pending")
    remarks       = Column(Text)
    created_by    = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at    = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())
